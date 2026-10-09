# Spike C: proxy (`@flutter-intercept/proxy`)

Date: 2026-10-08. mockttp 4.6.3, Node 26.4 (tests), Dart 3.13.5 (real `dart:io` client), macOS arm64.

## Verdict: is mockttp enough for all 5 actions?

**Yes.** Pass-through + record, mock, block (reset or status), request breakpoint and response
breakpoint (resume with edit, abort, timeout auto-resume) all work against a **real dart:io
HttpClient** over both plain `http://` (absolute-URI proxying) and HTTPS (CONNECT + MITM with an
in-memory CA). Two things needed small, isolated workarounds (below): binding to 127.0.0.1, and
upstream connection pooling. Beyond those, mockttp's public API (`thenPassThrough` with
`beforeRequest`/`beforeResponse`, `.matching()`, server events) was enough.

`npm test` (vitest, packages/proxy): **4 files, 64 tests passing**, stable over repeated runs
(about 4.5 s, including 12 tests that drive a compiled Dart client). `npm run build` emits `dist/`
with `.d.ts`.

## What's implemented (CONTRACTS §3, including the lead's update)

- `InterceptProxy` with `start/stop/port/setRules/getExchanges/clear/resume/abort`, events
  `'exchange'` (full snapshot, a copy) and `'removed'` (ids evicted from the ring buffer).
- `pausedAt` / `pauseDeadline` are set while paused and cleared afterwards.
- Edits: `headers` (`string | string[]`) **replace** the whole header set; `body` is decoded
  text. The proxy re-encodes it per `content-encoding` (gzip / x-gzip / deflate / br, and zstd
  where Node has it; any other encoding drops the header and sends identity), sets an exact
  `content-length` and removes `transfer-encoding`. Mock and block bodies are framed the same way.
  A stale `Host` left over from the original request is dropped when it still equals the original
  value, so redirecting the URL to another host works.
- Pure helpers `matches()` and `ruleFromExchange()` live in `src/rules.ts`, which has type-only
  imports. They are exported from the index and from the subpath
  **`@flutter-intercept/proxy/rules`**, which loads without mockttp (verified). The webview should
  import from the subpath. Globs are case-sensitive, `*` matches any characters including `/`,
  `/regex/flags` is honoured (with g/y removed), an invalid regex never matches (see
  `isInvalidMatcher`), the method is case-insensitive, and `''`/`'*'` match any.
- Upstream failure (refused, DNS, TLS verification, reset) returns **502 with the error text** to
  the app and records the exchange as `error` (status 502). The app never hangs on a dead upstream.
- A TLS handshake failure from the app is recorded as a `CONNECT https://host/` exchange in state
  `error` that names certificate pinning. Tested with a Dart client that has no
  `badCertificateCallback`.
- Behaviour choices:
  - `resume`/`abort` on an id that isn't paused is a silent no-op. This covers resumes that arrive
    after a timeout or after the client left.
  - `resume` **throws** on an invalid edit (bad URL or scheme, bad status) and leaves the exchange
    paused.
  - The default block status is 403 with the body `Blocked by Flutter Intercept`.
  - `clear()` keeps in-flight (pending or paused) exchanges.

## mockttp 4 API notes and quirks I relied on

1. **`server.start(port)` binds every interface (`::`)**, and there is no host option. A MITM
   proxy reachable from the LAN is an exposure. `src/listen-host.ts` wraps the CommonJS export
   `mockttp/dist/server/http-combo-server#createComboServer` (it is called as
   `(0, mod.createComboServer)(…)`, so patching the export works). It injects the host into that
   one `listen(port)` call, and passes the host through AsyncLocalStorage. Fallback: close and
   re-listen. Tested: 127.0.0.1 by default, `0.0.0.0` when asked. This **survives an esbuild bundle**
   (verified by bundling with `--external:tls-impersonate`).
   **Fails CLOSED (review #5):** after `start()` the proxy reads the address it actually bound. If it
   doesn't equal the requested host (`localhost` accepts 127.0.0.1 or ::1), it stops the server and
   throws `proxy bound to <addr> instead of <host>; refusing to run`. It also throws if mockttp's
   server object can't be found at all. Tested with a seam (`listenHostTesting`):
   - hook disabled → the fallback re-listens on 127.0.0.1;
   - hook and fallback both disabled → `start()` rejects, and the port is released.
2. **Rule completion semantics**: with more than one rule, mockttp prefers the *last* matching
   rule once a rule has handled a request, unless rules carry a completion checker. All of ours use
   `Always`.
3. **Routing (rewritten for review #3)**: three mockttp rules, added with `addRequestRules`.
   - Each rule uses a **synchronous matcher that reads only method, URL and headers**.
     `.matching(cb)` awaited the whole request body, so it is no longer used.
   - The decision is made once per request id, by whichever rule's matcher runs first.
   - Routes:
     - `h1` = `beforeRequest`: mock, block, request breakpoint. A forwarded response streams.
     - `h2` = `beforeRequest` + `beforeResponse`: response/both breakpoints. This is the only route
       that buffers a response.
     - `plain` = streaming passthrough.
   - **`beforeResponse` buffers the whole upstream body**, which is why only `h2` has it. SSE and
     large downloads stream on every other route (tested).
4. Short-circuits: `beforeRequest` returns `{response: {...}}` (mock or block status) or
   `{response: 'reset'}` (block reset or abort). A pending `Promise` holds the request open for
   a breakpoint. `beforeResponse` returns a `CallbackResponseMessageResult`, `'reset'`, or
   `'close'`. I pass `rawBody` plus my own framing so mockttp doesn't warn about content-length
   mismatches.
5. Client disconnects while paused show up as the server `'abort'` event (`rawResponse 'close'`).
   We then settle the pause with `'close'`, so the request is **never forwarded** after a client
   timeout and a late `resume` is a no-op.
6. `simulateConnectionErrors: false` gives the 502. Side effect: mockttp writes
   `console.error("Failed to handle request: …")` for each upstream failure. **There is no clean off
   switch.** The call in `MockttpServer.handleRequest` is unconditional, and mockttp 4 has no logger
   option. The only silent mode is `simulateConnectionErrors: true`, which resets the connection
   instead of returning a 502 (an `AbortError`, logged only with `debug`). I kept the 502, as the
   lead asked, so this is noise in the extension host log only.
7. **`maxBodySize` (now 5 MB) is safe only if nothing reads a request body before the passthrough
   streams it.** mockttp's body buffer drops its data past the limit:
   - If *it* was the first reader (the old `.matching()` callback, a `'request'` listener, or a
     `'request-body-data'` listener), a later `asStream()` returns an **empty** body. A 40 MB
     upload then hung ("socket hang up"). This is a mockttp bug: `completedBuffer` is set to
     the truncation's empty Buffer.
   - If the passthrough's own `asStream()` reads first, truncation hands over to live streaming
     correctly.

   So we subscribe to **no** request-body events, and record bodies from a passive tap instead
   (quirk 11). Without a limit, mockttp kept every in-flight byte (`currentChunks`): +847 MB RSS
   for a 420 MB download.
8. `recordTraffic: false` is set: mockttp would otherwise keep every request forever.
   `http2: false` is set because Dart is HTTP/1.1.
9. Recording is asynchronous (bounded decode for display), so a plain exchange can turn
   `completed` a few ms *after* the client has the whole body. Tests wait with `settled()`.
   - A `'response'` listener is still registered, as a no-op. It makes mockttp consume (and, past
     `maxBodySize`, discard) its internal tracking copy of each response. With no consumer, that
     PassThrough would buffer the whole body.
   - `'response-body-data'` isn't used for capture: it concatenates chunks for 20 ms batches
     (quadratic at loopback speed).
10. Upstream certificate checking is **strict by default**. Otherwise the app would lose all TLS
    verification, since it trusts the proxy blindly. I added the option
    `ignoreUpstreamCertErrors?: boolean | string[]`, which the tests use for their self-signed
    upstream.
11. **Passive taps (`src/taps.ts`)** wrap `mockttp/dist/util/request-utils#trackResponse`, which
    gets each raw `ServerResponse`, whose `.req` already carries mockttp's request id.
    - **Request:** `req.emit` is wrapped to see `'data'`/`'end'` *without adding a listener*.
      Adding one would start the stream flowing before mockttp reads it, and data would be lost.
    - **Response:** the tracked response's `write`/`end` are wrapped, and `finish`/`close` give the
      real completion time.
    - Only the first 5 MB of each direction is copied; totals are counted.
    - Display decoding (`decodeForDisplay`) works on that prefix: gzip, deflate or br with
      sync-flush, so a cut stream still decodes. Output is capped at 5 MB, which also stops
      decompression bombs.
12. **Response-breakpoint cap**: `mockttp/dist/util/buffer-utils#streamToBuffer` is wrapped. It is
    only ever called *without* a size argument to buffer an upstream response for
    `beforeResponse`. That buffer is now capped at 32 MB. Above the cap the upstream is destroyed
    and mockttp answers 502 with our message ("larger than 32 MB, too large to hold at a response
    breakpoint…"), and the exchange becomes `error`.
    - `start()` refuses to run if either hook (11 or 12) can't be installed, because recording
      would otherwise be unbounded.
    - Both hooks are verified in the minified extension bundle by the bundle smoke test.

### tls-impersonate (the blocked install script)

This is an *optional* dependency of mockttp. It is only `require`d (inside try/catch) when a
passthrough rule sets `mirrorTlsFingerprint: true`, and we never do. It ships N-API prebuilds
(darwin-arm64/x64, linux, win32) that `node-gyp-build` finds at runtime, so the blocked install
script doesn't matter. It loads and reports `isSupported() === true` on Node 26. Its engines field
needs Node ≥ 24.15, and VSCode's Electron Node is older, so it would be unused there anyway.
**It doesn't matter for us**; mark it `--external` when bundling the extension.

## Measurements

Local upstream (loopback), `node --expose-gc scripts/measure.cjs` (500 sequential requests per row):

| client | path | mean | p50 | p99 | first request |
|---|---|---|---|---|---|
| Node keep-alive | HTTP direct | 0.08 ms | 0.07 | 0.26 | |
| Node keep-alive | HTTP via proxy | 0.20 ms | 0.17 | 0.60 | |
| dart:io HttpClient | HTTP direct | 0.08 ms | 0.08 | 0.18 | 0.9 ms |
| dart:io HttpClient | HTTP via proxy | 0.17 ms | 0.15 | 0.37 | 1.0 ms |
| dart:io HttpClient | HTTPS direct | 0.10 ms | 0.10 | 0.18 | 6.3 ms |
| dart:io HttpClient | HTTPS via proxy | **1.9 ms** | 1.9 | 2.8 | 15 ms (leaf cert generation, then cached) |

- **Finding: dart:io never reuses a proxy CONNECT tunnel.** Measured: 21 HTTPS requests on one
  `HttpClient` produced 21 TCP connections to the proxy
  (`scripts/probe_connections.cjs`). Each HTTPS request through any proxy therefore pays for TCP,
  CONNECT and a TLS handshake to the proxy, which is the ~1.8 ms above on loopback.
- mockttp pools upstream connections **per downstream connection**. Combined with the finding
  above, every Dart HTTPS request also paid a **fresh TLS handshake to the real server** (7.8 ms
  locally; 1–2 extra RTTs on a real network). `src/upstream-pool.ts` wraps
  `mockttp/dist/rules/http-agents#getAgent`. For our rules only (recognised by a unique
  `proxyConfig` callback) it returns one shared keep-alive `http.Agent`/`https.Agent` per proxy.
  Node's agent naming keeps strict and lax TLS configs apart. Result: upstream TLS connections for
  N Dart requests went from N to 1, and the local mean went from 7.8 to 1.9 ms. This is
  regression-tested in the Node and Dart suites.
- CA generation in memory takes ~20–50 ms (proxy `start()` ~55 ms in total).
- **Memory (ring buffer)**: 2000 requests with 100 KB bodies.
  - `maxExchanges=100`: +7 MB heap.
  - `maxExchanges=1000`: +99 MB heap, which is roughly the size of the stored bodies. The heap
    stays flat once the buffer is full.
  - Risk: 1000 × (5 MB request + 5 MB response) could reach about 10 GB, so I added the byte
    budget `maxStoredBodyBytes` (default 256 MB). It evicts oldest finished exchanges and emits
    `'removed'`.
  - Bodies in flight are buffered in full (see quirk 7). A multi-GB download costs that much RSS
    for a moment.
- **Paused response longer than the client's timeout** (Dart client with a 1 s timeout, which
  stands in for Dio's `receiveTimeout`; also Node clients):
  - The app sees `TimeoutException`.
  - The proxy gets the socket close and marks the exchange `error` ("Client closed the connection
    while the response was paused (client timeout?)").
  - A late `resume`/`abort` is a no-op.
  - The proxy keeps serving.
  - For a paused **request**, the upstream is never contacted.
  - **No crash.** The UI should show `pauseDeadline` and warn that the app's own timeout (often
    shorter than 5 min) may fire first.

## Files

- `packages/proxy/src/{index,intercept-proxy,rules,body,types,listen-host,upstream-pool,taps}.ts`
- `packages/proxy/package.json` (adds `exports` for `./rules` and `./types`, plus
  `typesVersions`), `tsconfig.json`, `vitest.config.mts`
- `packages/proxy/test/{rules,proxy,dart,large,memory}.test.ts`, `test/helpers.ts`,
  `test/fixtures/dart_client.dart`
- `packages/proxy/scripts/{measure.cjs,memory-large.cjs,dart_bench.dart,probe_connections.cjs}`

## Bundle (Phase 2: shrinking `packages/extension/dist/extension.js`)

| | Before | After |
|---|---|---|
| `dist/extension.js` | 4,495,088 B (4.29 MB) | **926,932 B (905 KB)**, −79 % |
| `.vsix` | 1,397,238 B (1.33 MB) | **293,407 B (287 KB)**, −79 % |
| Load (parse + eval) of `extension.js`, plain Node, stub `vscode`, 5 runs | 48–57 ms | **17–19 ms** |
| First proxy start: `require('@flutter-intercept/proxy')` + `start()`, minified bundle, 5 runs | require 106–122 ms + start 66–97 ms | require **44–50 ms** + start 39–109 ms (start is dominated by RSA key generation for the in-memory CA, which varies) |

There were two changes, both scoped to code paths InterceptProxy can never take:

1. **The proxy no longer imports mockttp's index** (`packages/proxy/src/intercept-proxy.ts`). The index
   (`dist/main.js`) eagerly loads the remote client, admin server and pluggable admin. That pulls
   in express, body-parser and raw-body (with iconv-lite tables), graphql, @graphql-tools, send,
   type-is/accepts (mime-db) and subscriptions-transport-ws. None of these are stubbed; they are
   simply never imported now. We deep-import exactly what we use:
   - `mockttp/dist/server/mockttp-server` (`MockttpServer`; `getLocal()` is literally
     `new MockttpServer(opts)`)
   - `mockttp/dist/util/certificates` (`generateCACertificate`)
   - type-only imports from `mockttp`

   mockttp's own `exports` map allows `./dist/*`. This also cuts plain-Node module initialisation.
2. **Stubs for the upstream-proxy agents**: `pac-proxy-agent`, `socks-proxy-agent` and
   `https-proxy-agent` → `packages/extension/stubs/upstream-proxy-agent.js`. PAC alone was about
   1 MB minified (a QuickJS wasm engine, esprima, escodegen, ast-types, basic-ftp, …).
   - **Why this is safe:** mockttp builds these agents only in `rules/http-agents.js#getAgent`,
     and only when the rule's `proxyConfig` resolves to a setting with a `proxyUrl`. Every rule we
     register (hooked, plain and websocket) passes `proxyConfig: pool.proxyConfig`, a callback that
     always returns `undefined`. mockttp reads no environment proxy variables:
     `getProxySetting(fn)` just calls the function.
   - **Guards:**
     - Each stub class **throws a clear error** if it is ever constructed.
     - The esbuild plugin **fails the build** if any file other than
       `mockttp/dist/rules/http-agents.js` imports a stubbed module.
     - A post-build check **fails the build** if mockttp's admin/client/pluggable-admin, its
       `main.js`, graphql, express, body-parser, raw-body, @graphql-tools, quickjs, pac-resolver or
       degenerator ever reappear in the metafile. For example, this catches someone writing
       `import … from 'mockttp'`.

Kept on purpose: `ws` (websocket passthrough), `http2-wrapper` (25 KB; imported at the top level of
the passthrough code, so stubbing it would save little and risk a lot), the @peculiar/asn1 stack
(CA and leaf certificates), and lodash.

### Proof the minified bundle still works
- **`npm run test:bundle`** (new, `packages/extension`) bundles `test/bundle/smoke.ts` with
  *exactly* the extension's esbuild options, stubs and guards, then runs it in plain Node. It
  asserts:
  - the listen-host patch binds `127.0.0.1`
  - the upstream-pool patch is active, and **5 CONNECT tunnels → 1 upstream TLS connection**
  - HTTPS pass-through, mock, and upstream failure → 502 recorded as `error`

  Output: `[bundle-smoke] ok: bound 127.0.0.1, pool active, 5 tunnels -> 1 upstream conn, mock + 502 ok, start 50 ms`.
- `npm test` in `packages/proxy`: 64/64 passing. `npm test` in `packages/extension`: 67/67 passing.
  `tsc --noEmit` is clean.
- `npm run test:integration` (source tree, isolated VS Code 1.141): **dart 39/39, flutter (macOS) 3/3**.
- `npm run test:vsix` (packaged `.vsix`, unzipped and loaded as the extension): **dart 39/39,
  flutter (macOS) 3/3**. The Android emulator and iOS simulator were not touched.

## Memory: bounded recording (review #3)

**Limits and what happens above them:**

| Path | Held in memory | Above the limit |
|---|---|---|
| Pass-through (no rule) | ≤ 5 MB preview per direction (tap) + ≤ 5 MB in mockttp's in-flight buffers | Streams normally. The recorded body is a 5 MB prefix with `truncated: true` |
| Mock / block | ≤ 5 MB of the request body | The request body preview is truncated. The response is the mock either way. The server is never contacted |
| Request breakpoint (`request`/`both`) | request body ≤ **5 MB, known length** | **Breakpoint skipped**: passed through unedited and streamed. The exchange keeps `matchedRuleId` and `error` = "Breakpoint skipped: the request body (40.0 MB) is over the 5 MB pause limit…" or "…streamed (unknown length)…", on a non-error state. Applies to chunked uploads and `content-length` > 5 MB |
| Response breakpoint (`response`/`both`) | upstream response ≤ **32 MB** | The app gets **502** with "Flutter Intercept: the response is larger than 32 MB, too large to hold at a response breakpoint…". The exchange is `error`. The upstream is destroyed, never buffered |
| Response breakpoint, 5–32 MB | full body (for forwarding) | Pauses. **Body edit refused** (`resume` throws "larger than 5 MB… only shown in part"), but status/headers edits work and the original bytes are forwarded |

**Measured** with `node --expose-gc scripts/memory-large.cjs` (420 MB per scenario; client and
origin are in the same process). RSS growth is the peak delta. The first row shows the allocator
noise of the transfer itself.

| Scenario (420 MB) | HEAD before the fix | After |
|---|---|---|
| Reference: direct download, no proxy | +89 MB | +121 MB |
| Plain download through the proxy | **+847 MB** (external 1.7 GB) | **+36 MB** |
| Plain upload | **+383 MB** (external 3.5 GB) | **+19 MB** |
| Request breakpoint + 420 MB upload | paused for 5 min (auto-resume), then forwarded | skipped with a note, **+7.5 MB**, 0.18 s |
| Response breakpoint + 420 MB download | paused for 5 min, **+783 MB** | 502 "too large", **+0.2 MB**, 16 ms |
| Mock + 420 MB upload | +343 MB | **+10 MB** |

`test/memory.test.ts` asserts this in CI: 420 MB down and up through the proxy, peak RSS growth
under 150 MB. Last run: download +31–40 MB, upload +6 MB. `test/large.test.ts` covers every
limit row above with 40 MB and 10 MB bodies.

## LAN mode (CONTRACTS §7, physical iOS)

**API** (`InterceptProxy`):
- `openLan({ host, token, port? }) → { host, port }`, `closeLan()`, `readonly lan`.
- `readonly lanPeer?: string` is the peer IPv4 pinned by the first successful authentication for
  the current token (review 2). The event `'lan-peer'` (ip) fires when it is pinned.
- Also exported: `lanIPv4Addresses()`, the concrete non-internal, non-link-local IPv4s of this
  machine.
- `openLan` throws when:
  - the proxy isn't started;
  - `host` isn't one of those addresses (`0.0.0.0`, `127.x`, `::` and foreign IPs are all refused);
  - the token is shorter than 16 characters;
  - the bound address isn't exactly `host`. Fail closed: the listener is closed again and `lan`
    stays `undefined`.
- Calling `openLan` again replaces the listener and the token.
- `closeLan` destroys every LAN connection and waits for them to close. `stop()` calls it.

**Architecture: a thin gate in front, the checks inside mockttp.** The other options were:
- A full second HTTP proxy in front that pipes into the loopback port. mockttp would then see
  every LAN request as coming from loopback, and the SSRF guard would need a side channel.
- Checks only inside mockttp. That can't work, because mockttp answers CONNECT itself (writes
  `200` and re-handles the socket) with no hook.

So:
1. **`LanGate`** (`src/lan.ts`) is a `net.Server` bound to exactly the LAN IPv4.
   - It reads the first request head of each connection and checks `Proxy-Authorization` and the
     pinned peer. Limits:
     - 64 KB per head;
     - a **two-phase** deadline: a silent socket may wait 120 s, and once the first byte arrives the
       whole head must arrive within an absolute 10 s;
     - at most 128 connections in total (when full, the oldest silent socket of a non-pinned host is
       evicted) and 64 per IP;
     - at most 32 heads still being read per IP. If that fails: `407` + `Proxy-Authenticate: Basic realm="proxy"`, empty
     body, close. No detail, and nothing is recorded.
   - For CONNECT it also refuses local targets (`403`, recorded as a `CONNECT` exchange in state
     `error`).
   - Otherwise it unshifts the bytes and hands the socket to mockttp's own connection handler
     (`comboServer.emit('connection')`, which is what mockttp itself does after CONNECT).
2. **Every later request on a plain keep-alive LAN connection** is checked in a per-instance
   `preprocessRequest` hook. That hook sees the original raw headers; mockttp strips
   `Proxy-Authorization` right after it, so the token is never forwarded upstream (tested).
   - A failure is answered `407` + `Connection: close` by a first mockttp rule, so earlier pipelined
     responses keep their order (tested: authorised request → 200, then unauthorised → 407, closed).
   - Websocket upgrades without credentials are refused directly.
   - Requests inside a CONNECT tunnel need no header (Dart sends it only on the CONNECT), because the
     tunnel was authorised by the gate.
   - A CONNECT that arrives *after* plain requests on the same connection never went through the
     gate. mockttp already wrote its `200`, so we destroy the socket the moment mockttp re-handles
     it, before any byte is tunnelled.
3. **LAN origin is decided by socket identity**, never by remote address. A WeakMap holds each
   socket the gate accepted, with *its gate*, and is walked up from TLS-in-tunnel sockets (`_parent`).
   **Every guard is keyed on that socket**, not on "LAN mode is on". A socket whose gate is closed
   is refused everywhere: 407 per request, the 403 rule, and no upstream agent (`getAgent` throws).
4. **Token check**: constant time. Both the decoded `user:pass` and the expected
   `flutter-intercept:<token>` are SHA-256'd and compared with `timingSafeEqual`, so length doesn't
   leak either. A repeated header is refused. The token is never logged.

**SSRF guard (LAN clients only)** forbids:
- loopback (127/8, ::1), unspecified (0/8, ::) and link-local (169.254/16, fe80::/10);
- every address of this machine's interfaces, read fresh from `os.networkInterfaces()`;
- the same addresses in IPv4-mapped IPv6 form;
- `localhost` / `*.localhost`.

It works in three layers:
1. **403 rule** (first mockttp rule, async matcher): resolves the URL the client asked for (DNS
   `all`) and answers `403` with "Flutter Intercept: blocked a LAN client's request to …"
   (`Connection: close`). The exchange is recorded as `error`.
   - This uses the client's URL *before* mockttp's own "localhost means the client's machine"
     rewrite (`getClientRelativeHostname`). So `http://127.0.0.1:…` from the phone is a 403, as the
     contract says.
2. **CONNECT targets** are checked at the gate.
3. **Connect-time check (DNS rebinding / TOCTOU):** for LAN connections, our `getAgent` hook returns
   `GuardedHttpAgent`/`GuardedHttpsAgent`. Their `createConnection` checks IP literals directly and
   wraps the `lookup` used for the real socket, so the address actually connected to is checked even
   if the name re-resolves differently (unit-tested with a rebinding lookup). A violation there
   fails the connection: mockttp answers 502 and the exchange is `error`.
   - Websocket upgrades from the LAN also go through guarded agents. They don't get the 403 rule,
     only the connect-time refusal.

**Tests** (`test/lan.test.ts`; socket tests run only when this machine has a LAN IPv4; here that is
192.168.1.20):
- Unit tests: the auth check, IP normalisation, the forbidden-address table, a rebinding lookup, and a
  guarded agent with a literal.
- Binds exactly the LAN IP. The LAN port isn't reachable on loopback. Loopback clients work without
  a token while the LAN listener is open. `closeLan` really closes, and loopback still works after it.
- 407 + close for missing, wrong-token and wrong-user credentials, plain and CONNECT. No detail in the
  response, nothing recorded, the server never reached.
- The keep-alive per-request check; CONNECT after plain is torn down.
- Right token: plain requests are recorded, and `Proxy-Authorization` is not forwarded.
- SSRF: `127.0.0.1`, `localhost`, `[::1]`, the LAN IP itself (another service, and the proxy port),
  `169.254.169.254` and `0.0.0.0` all get 403 + `error`, and the live local services see no hits.
  CONNECT to `127.0.0.1` → 403. Inside an allowed tunnel, `Host: 127.0.0.1:<other>` → 403.
- Bind fails closed (test seam binds `0.0.0.0` → `openLan` rejects, nothing listening). Host and
  token validation. Re-opening rotates the token.
- **Real dart:io client** with `PROXY flutter-intercept:<token>@<lanIp>:<port>`: HTTPS and HTTP are
  intercepted end to end, and a response-breakpoint edit arrives. A wrong token gets 407 and nothing
  reaches the server. `https://localhost:<svc>` and `http://127.0.0.1:<svc>` are refused.
  - These runs use the fixture's new `DART_CLIENT_NO_DIRECT=1`. With `; DIRECT`, Dart falls back to a
    direct connection when the proxy answers a CONNECT with 403 or 407. On a phone that only reaches
    the phone itself, but in a test on the Mac it would hit the Mac.
- The test seam `lanTesting.allowTarget` exempts exactly one upstream (on the LAN IP, specific
  ports), because every service a test can start is "this machine". Everything else stays forbidden.
- The minified bundle was also checked (scratch build, same esbuild options and stubs): no
  credentials → 407, a loopback target → 403, CONNECT localhost → 403.

### Review 2 hardening (2026-10-09)

**#1 Close race (MED).**
- **Cause:** `close()` destroyed sockets and waited before `server.close()`. A connection accepted
  in that window was handed to mockttp after `lanGate`/`pool.lan` were cleared, so it ran with no
  guards.
- **Fix, part 1:** `close()` now sets `closed` and calls `server.close()` **first**. `onConnection`
  and `onHead` refuse once closed, including after the async CONNECT target check. Only then are
  sockets destroyed and awaited.
- **Fix, part 2:** every guard is keyed on the socket (above). So even a socket that somehow
  outlives its gate gets nothing.
- **Regression evidence:**
  - The reviewer's `race-server2`/`race-client2`, run 3 times against the fixed build: ~13,000
    connections opened, **0 still open after `closeLan`**, 0 hits on the 127.0.0.1-only service.
    `closeLan` took 5–11 ms (it was 5.8 s).
  - Test `#1 close race` hammers about 2,700 connections across `closeLan`: 0 survivors, 0 secret hits.
  - Test `#1 guards are keyed on the socket` uses the seam `keepSocketsOnClose` to keep an
    authenticated keep-alive socket and an authenticated CONNECT tunnel alive past `closeLan`:
    - the plain socket's next request (no token, `0.0.0.0:<secret>`) gets **407**;
    - the tunnel's next request gets **403/407**;
    - the secret service is never hit.

**#2a Peer pinning (MED, design).**
- The first request that authenticates pins its source IP for the lifetime of the token.
- Any other IP gets 407 even with the valid token, on the first head, on CONNECT and on every
  keep-alive request.
- `openLan` (token rotation) starts a new gate with no pin.
- Exposed as `lanPeer`, plus the `'lan-peer'` event.
- Tested with a peer-IP seam: pin, then another IP with the token → 407 (plain and CONNECT), then the
  pinned IP → 200, then rotation re-pins.

**#2b Networks the phone isn't on (MED, design) — route-based (follow-up, 2026-10-09).**
- **Why the first version changed:** it refused every private range outside the Wi-Fi /24. That
  broke a common setup: a dev backend at a private IP the phone legitimately reaches over the same
  Wi-Fi or corporate routing (for example `http://10.20.30.40:8080`).
- **The rule now:** for LAN clients, a target is refused when **this Mac would send it out of an
  interface other than the listener's** (utun, ipsec, ppp, bridge, vmnet, vboxnet, docker…), on top
  of the hard rules (loopback, link-local, unspecified, multicast, own addresses).
- **What is allowed:** targets routed through the listener's interface, whether its subnet or its
  gateway (the internet, corporate routed networks).
- **What it still refuses:**
  - tailnet peers (utun has a /32 address, but 100.64/10 routes via utun);
  - VM and bridge networks;
  - **public addresses captured by a full-tunnel VPN**. This was an open issue before; those routes
    go via utun.
- It applies in all three layers: the 403 rule, the gate's CONNECT check, and the connect-time check
  on the address actually connected to.
- **Routing table:** `src/routes.ts` parses `netstat -rn -f inet` and `-f inet6` into a
  longest-prefix-match table.
  - Map per prefix length, so a lookup is at most 33/129 hash probes. The real table here has about
    2,200 routes.
  - Interface-scoped routes (flag `I`: per-VPN defaults, ARP entries) are skipped, because only the
    unscoped table applies to a normal `connect()`.
  - No subprocess per connection. The table is cached and refreshed in the background every 10 s,
    and `openLan` loads it before accepting.
  - When the interface set changes (VPN up/down, new network) the old table is not trusted; we fail
    closed until the fresh one is in.
- **If the table can't be read** (not macOS, `netstat` fails, empty output), we fail closed and log
  once. Only the listener interface's subnets and non-private addresses are allowed; other
  interfaces' subnets and private ranges are refused. That is the previous behaviour.
- **Tests:**
  - Synthetic netstat and interface tables:
    - the parser handles classful shorthand like `192.168.0` (= /24), `127` (= /8), `0/1` and
      `128.0/1`, and skips scoped defaults;
    - `10.20.30.40` via the en0 default is **allowed**, and so are `172.20.1.1` and the Wi-Fi subnet;
    - `100.64.0.5` via utun, `10.211.55.3` via vnic0, `192.168.64.2` via bridge100 and an ULA via
      utun9 are **refused**;
    - full tunnel (`0/1` + `128.0/1` via utun, and an unscoped default via utun): public addresses
      are refused, while the Wi-Fi subnet is still allowed;
    - split tunnel (`10/8` via utun): 10.x is refused, the longer vnic0 /24 still wins, and
      192.168.0.x is allowed;
    - no route → refused;
    - unreadable table → the fallback.
  - **Real table:** 50 host routes via other interfaces (this Mac's corporate VPN routes via `utun1`)
    are all refused, a Wi-Fi neighbour is allowed, and `8.8.8.8` is allowed while the default route
    is en0.
  - **End to end on the LAN listener**, with a synthetic route `192.0.2/24 via utun99`: a plain
    request and a CONNECT both get 403 "routed through utun99" without connecting.
  - **Minified bundle:** `http://100.64.0.5/` → 403 "routed through utun1, not the Wi-Fi interface en0".

**#3 DoS (LOW-MED).**
- **Changes:**
  - an absolute head deadline (10 s from accept);
  - `server.maxConnections = 128`;
  - 64 connections per IP, and 16 per IP still reading a head;
  - an incremental `\r\n\r\n` scan: each chunk is scanned once with a 3-byte overlap, and the head
    is concatenated once.
- **Why the caps are larger than the lead's suggested 64/16:** dart:io opens a new tunnel per HTTPS
  request, and app cold starts have 20–40 requests in flight.
- **Evidence:**
  - Reviewer's `slow.js` (1 byte every 10 s): `closed = true` (it used to stay open ~10 days).
    Test `#3 slowloris` with a 500 ms deadline and a byte every 100 ms closes at about 500 ms.
  - Reviewer's `dos-server`/`dos-client`, 300 slow 64 KB heads:

    | | Event-loop lag peak | Busy | RSS growth |
    |---|---|---|---|
    | Before | 310 ms | 89% | +50 MB |
    | After | **65–171 ms** | 56–66% | **+1 MB** |

  - For scale: a bare `net.Server` that only accepts and drops the same 300-connection burst shows
    218–288 ms lag on this machine (`dos-floor.js`), so what remains is the cost of the TCP accepts
    themselves.
  - Test `#3 flood` runs the reviewer's client (`test/fixtures/lan_dos_client.cjs`) as a child
    process and asserts RSS growth < 40 MB (measured +0.9–1.9 MB) and that the proxy still serves an
    authenticated request. Test `#3 pending cap` checks that exactly 16 idle heads per IP stay open.

**Follow-up: a debugger-paused cold start (regression from #3, found on a real iPhone).**
- **Symptom:** on a physical-iPhone *debug cold start*, `package:http` requests went DIRECT and
  unrecorded, and plain `http://` failed with "Connection closed before full header was received".
  Hot restart, profile mode, the emulator and the simulator all passed.
- **Root cause, confirmed:** the absolute 10 s deadline from accept. During a cold start the debugger
  pauses the isolate for about 20 s after the socket has connected but before the head is written.
  The gate killed the silent socket at 10 s:
  - for CONNECT, Dart then falls back to `DIRECT`;
  - for plain HTTP, the request fails.

  New test: connect, stay silent for 15 s, then send an authenticated head. It **failed** on
  ccb05a5 (the socket was closed at 10 s), and passes after the fix. The same test sends a wrong
  token after the wait and gets 407.
- **Fix: a two-phase deadline.**
  - A silent socket (connected, no byte yet) waits up to **120 s**. It costs no buffer, and the
    per-IP pending cap and the 128 total bound how many there can be.
  - The **first byte** replaces that with the short, **absolute** 10 s head deadline. A trickling
    slowloris client can't extend it, and a real client writes its head in one go.
- **Pending cap 16 → 32 per IP:** a paused cold start can leave more requests waiting at once.
- **Long silent waits could let other LAN hosts park 128 idle sockets and lock the phone out.** So the
  hard cap is now managed by the gate instead of `server.maxConnections`: when full, the oldest
  silent socket of a host that isn't the pinned peer is evicted.
- **Tests:**
  - the paused-client test (15 s);
  - two-phase: a silent socket survives past the head deadline, its first byte then starts the short
    one, and a socket that never speaks is dropped at the silent deadline;
  - a full gate (128 squatters from 8 other "hosts") still lets the pinned phone in, by evicting one;
  - the pending cap is now 32.
- **Reviewer's scripts rerun:**
  - `slow.js` → `closed = true` (10 s after its first byte).
  - `dos` (300 slow 64 KB heads), 5 standalone runs: lag peak 15–94 ms (one run at 655 ms) and RSS
    +3–4 MB. The bare accept-and-drop `dos-floor.js` ranged 86–664 ms in the same session, so the
    remaining lag is the TCP accept burst, not the gate.
- **Suite:** 109 proxy tests passing, twice in a row. An earlier run had timeouts, but its tests
  reported durations of 600–1000 s, which means the machine went to sleep mid-run.

**CI flakiness (2026-10-09, before the repo went public).**
- **What happened:** in a CI-like local mirror (fresh clone, `npm ci`, `CI=true`, Node 22.23.3),
  `#1 guards are keyed on the socket` intermittently saw 7–9 `GET /json` instead of 1, and
  `#2a pins…` failed once.
- **Root causes (all test-side; no product bug found):**
  1. **Shared upstreams across tests.** The close-race test forwards thousands of `GET /json` to the
     same `up` server the next test counts, and its client sockets were destroyed without waiting.
     Requests still in flight, or connections still in SYN, could land after the next test reset
     the counter.
  2. **Port reuse with a shared token.** Each test opens a new LAN listener on port 0, and the OS can
     hand out the port the previous test just freed. A straggler from the previous test then
     authenticates there with the (same) token. That inflates hit counts, and it can **pin the
     peer** before `#2a` starts.
  3. **A fake-peer race in `#2a`.** The pretend source IP was registered on the client's `connect`
     event, while the gate reads it at accept time. Whichever ran first decided the pin.
  4. **The post-flood check expected an instant 200.** Right after the 300-connection flood, the
     kernel accept queue (macOS somaxconn 128) can still be full, so a new SYN is retransmitted after
     1 s, 2 s, 4 s. Measured on Node 22: the first byte arrived after 2.7–8 s.
- **Fixes:**
  - fresh upstreams per test (and closed after it), in both LAN suites;
  - a random token per test;
  - the close-race test captures its request string up front and awaits every socket's close;
  - fake peers come from an accept-order queue (`fakePeers()`) for pinning and the full-gate test;
  - the pending-cap test waits on the gate's own counters instead of sleeps;
  - the post-flood check retries for up to 20 s;
  - wall-clock bounds are widened for loaded CI runners, still far below "never" for the property
    each one checks. Event-loop lag is now a 5 s sanity bound; the RSS bound is the real assertion.
- **Linux (ubuntu-latest):** see the notes in the routes test. `routes.ts` is macOS-only, so on Linux
  the table is `null`, the guard runs in fail-closed fallback, and it logs once. A test asserts that
  (table `null`, private target outside the subnet refused, public allowed). The real-table test
  only runs on macOS; synthetic route tests pass their table explicitly. The LAN socket tests use
  the test seam for the one allowed upstream and hard-forbidden targets for SSRF, so they don't
  depend on the route table or on IPv6 being available.

**CI run 37927559659 (first public CI): the close-race test, an artefact, not a bypass.**
- **Symptom:** `#1 close race` failed on both runners, "expected 83 / 240 to be 0" (ubuntu
  10.1.0.216, macOS VM 192.168.64.17).
- **The same CI logs:** `[race] opened 1665, survivors 83, replies [], secret hits 0` (ubuntu) and
  `opened 1245, survivors 240, replies [], secret hits 0` (macOS).
- **Why that is not a bypass:**
  - The old test counted as a "survivor" every client socket not yet closed 500 ms after the
    hammer stopped. That includes sockets still `opening` (SYN pending), and sockets the kernel
    completed or half-completed while the accept queue overflowed on a slow runner.
  - Those sockets have **no server-side socket at all**. They only learn of it on their next SYN
    or data retransmit (RST), which can take seconds.
  - A real survivor, a socket accepted by the gate and handed to mockttp, answers. With the guards
    keyed on the socket it answers 407/403; the `#1 guards are keyed on the socket` test proves that,
    and it passed on both runners. Without the guards it serves (the reviewer's original exploit got
    `SECRET`).
  - Here: no reply to any probe, and 0 secret hits.
- **Reproduced locally under CPU stress** (14 busy processes on 14 cores): `client-side open at
  probe 3 {"opening":3}`. Those were still-connecting sockets, so the old assertion would have
  failed. They received no reply and closed by themselves.
- **Test fix** (product code unchanged). The test now asserts the security property:
  1. **Server side, deterministic:** right after `closeLan`, the gate is closed and holds **0
     sockets**.
  2. **Client side, probed immediately:** every socket still open gets an **authenticated** request
     to an allowed upstream that only the probe uses, then an unauthenticated request to the
     loopback-only service. The authenticated one goes first, because the unauthenticated one would
     be 403'd by the SSRF rule even on broken code.
  3. **After TCP settles** (up to 20 s for SYN and data retransmits): 0 hits on both services, and
     nothing but a 403/407 ever came back. State counts are logged.
- **Mutation check:** I reintroduced the bug (sockets outlive close, no closed-gate refusal, no
  per-request auth, guards off for closed gates).
  - The test fails on (1), with 64 sockets kept.
  - With (1) disabled it still fails on (2): `probe hits 45`, `replies ["HTTP/1.1 200 OK"]`.
- **Also:** the flood test now asserts the gate's caps deterministically (max sockets ≤ 128, max
  pending per IP ≤ 32), sampled every 10 ms during the flood. RSS stays a sanity bound: 40 MB on
  macOS, 100 MB on Linux (CI ubuntu showed +38 MB from glibc noise while the gate held about 2 MB).
  The keyed-on-socket test and the default wait were given stress-tolerant timeouts.
- **Results:**
  - Fresh clone of 6980cc8 plus this fix, Node 22.23.3, `CI=true`: **5/5 runs, 110/110**.
  - Under CPU stress: 2/2, 110/110.

The LAN socket tests run in one file (`lan.test.ts` imports `lan-hardening.suite.ts`), so the flood
doesn't starve the timing-based tests. Total after the route-based follow-up: **106 proxy tests passing, 3 runs in a row**; 212
extension unit tests passing; minified-bundle LAN smoke test OK.

## Open issues

- LAN mode: **IPv4 only** (per contract). The SSRF rule is route-based and macOS-only
  (`netstat -rn`). Elsewhere it falls back to "Wi-Fi subnet + public addresses only". Policy routing
  (pf rules, per-app VPNs) isn't visible in the routing table. NAT64 forms of loopback aren't mapped.
- The token still travels in clear on the Wi-Fi (review 2 #2). Pinning limits a sniffed token to
  the first peer's IP. An attacker who also spoofs that IP on the same LAN is not stopped.
  Websocket upgrades to local targets are refused at connect time (the connection fails) rather
  than with a 403.

- Request breakpoints don't apply to **chunked (unknown-length) request bodies**. They are skipped
  with a note, because mockttp would drop data past its buffer limit. Most Dart clients (Dio, http)
  send a content-length; streamed uploads don't.
- WebSockets are passed through but **not recorded**, and rules don't apply to them.
- mockttp forwards a client's `Connection: close` upstream. That is harmless (Dart doesn't send
  it), but it defeats pooling for such clients.
- An upstream that accepts but never answers: the proxy adds no timeout of its own, so the app's
  timeout applies exactly as it would without the proxy.
- `console.error` noise from mockttp on upstream failures (quirk 6).
- The two monkey-patches (`createComboServer`, `getAgent`) depend on mockttp's internal layout.
  Both degrade safely: re-listen fallback, and default pooling. **Pin mockttp to `~4.6.3`**
  (`package.json` currently says `"*"`; I didn't change it, to keep the lockfile untouched).
- Each new HTTPS host costs ~10 ms once for leaf-certificate generation (RSA).

## Requested contract changes

1. Add `InterceptProxyOptions.ignoreUpstreamCertErrors?: boolean | string[]` (default false =
   strict). Implemented. The extension may want a setting for self-signed staging servers.
2. Add `InterceptProxyOptions.maxStoredBodyBytes?: number` (default 256 MB). Implemented.
3. Document that `clear()` keeps in-flight exchanges and that the host should send a fresh
   `snapshot` after `cleared`. Also: `resume`/`abort` on a non-paused id are no-ops, and `resume`
   throws on an invalid edit.
4. Document the subpath `@flutter-intercept/proxy/rules` (dependency-free) for the webview.
5. `ExchangeState` has no "client gave up" value. Today it is `error` with a message. Consider
   `'aborted-by-client'` if the UI wants to style it differently.
6. Binary bodies: `ResponseEdit.body` is text only, so the UI must omit `body` when it wasn't
   edited (otherwise a base64 display body would be sent back as text).
7. **Add `Exchange.note?: string`.** Today, a breakpoint skipped because of the size limit is
   reported through `error` on a non-error state (`completed`). The webview shows `error` as
   the badge tooltip, so it is visible, but `note` would say what it is.
8. **Mock headers and repeated headers**: `RuleAction` mock `headers` is `Record<string, string>`,
   so `ruleFromExchange` joins several `set-cookie` values with `, `, which breaks cookies that
   contain `Expires`. Proposal: `Record<string, string | string[]>`. The proxy already sends
   arrays correctly at runtime (`frameBody` and mockttp accept them).
9. `ruleFromExchange(e, 'mock')` now throws `RuleFromExchangeError` with code
   `'truncated' | 'binary'` (exported from both the index and `/rules`). The host already maps it
   to an `error` message (packages/extension controller).
