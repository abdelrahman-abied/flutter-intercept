# Spike: gRPC (HTTP/2) interception (0.10.0 candidate)

Date: 2026-10-11. Dart 3.13.5 (Flutter 3.47.7), grpc-dart 5.1.0 (same connect code in 2.9.0, 3.2.4, 4.0.1),
connectrpc 2.0.0, mockttp 4.6.3, @grpc/grpc-js 1.14.6, Node 26.4, macOS arm64. Harness (scratch, not committed):
a grpc-dart `Server` with raw-bytes Unary / ServerStream / Bidi methods (no protoc), a Dart program that mirrors the
generated entry, a stand-in front proxy (silent CONNECT, passthrough or MITM, ClientHello parser), and Node scripts
that put a grpc-js client and server around mockttp. Suite: unary with header / trailer / `-bin` trailer,
trailers-only `UNAVAILABLE`, 3 MB each way, server / client / bidi streaming, 500 ms deadline, client cancel.
Demand: [devtools#2044](https://github.com/flutter/devtools/issues/2044), the most-voted open Network request
(ROADMAP §2, last ❌ row).

## Verdict

| | Result |
|---|---|
| Catch grpc-dart's connection from the entry, zero app code | ✅ `IOOverrides.socketConnect` (global), filtered by stack frame |
| Insecure gRPC (h2c, `localhost:50051` style): see, mock, fault | ✅ end to end, incl. streaming, trailers, cancel, deadline, gzip |
| TLS gRPC with the default `ChannelCredentials.secure()`: see contents | ❌ without OS-level trust of our CA (below); ✅ metadata only (passthrough) |
| TLS gRPC when the app trusts us (pinned to our CA, or `onBadCertificate` in debug) | ✅ MITM |
| HTTP/1.1 traffic, Flutter Web in Chrome | unchanged with mockttp `http2: 'fallback'` |
| Release builds with `--obfuscate` / `--split-debug-info` | ⚠️ frame filter misses → goes direct (fail-safe) |

## Dart side (entry)

**How grpc-dart connects.** `SocketTransportConnector` (lib/src/client/http2_connection.dart) always opens a plain
`Socket.connect(host, port)`, then for TLS `SecureSocket.secure(socket, context: credentials.securityContext, …)`.
`HttpClient` and `dart:io` `WebSocket` use `Socket.startConnect` / `SecureSocket.startConnect`, so a
`socketConnect` override never sees them (measured: no call). `GrpcOrGrpcWebClientChannel` on native is a plain
`ClientChannel`.

**`IOOverrides` is `abstract base class`.** A subclass needs `final class`, which pre-3.0 language-version apps
can't parse. Don't subclass: `IOOverrides.runZoned(() => IOOverrides.current!, socketConnect: f)` returns a scope
that is a ready-made `IOOverrides` and can be assigned to `IOOverrides.global`.

**Install global only, never in the zone.** A zone install shadows an app's later `IOOverrides.global` (its
`createFile` calls dropped from 1 to 0). Apps that layer `IOOverrides.runZoned(createFile: …)` keep our hook; apps
that replace the global or `runWithIOOverrides` their own lose gRPC interception but keep working (worth a one-time
note when the global is no longer ours).

**Filter.** Redirect only when `StackTrace.current` contains `package:grpc/src/client/http2_connection.dart`; the
frame is synchronous (`#3 SocketTransportConnector.initSocket (…http2_connection.dart:417)`) in JIT and plain AOT.
Cost 20–350 µs per `Socket.connect`. Raw sockets, MQTT-style clients and Unix-domain sockets stay direct.
`--dwarf-stack-traces` / `--obfuscate` hide the frame → direct.

**Redirect: "silent CONNECT".** The override connects to the proxy (≤ 2 s, or the app's `connectTimeout` if
shorter), writes `CONNECT host:port` + `Flutter-Intercept-Tunnel: silent` (+ `Proxy-Authorization` in LAN mode,
+ `Flutter-Intercept-Connect-Timeout`) and returns the socket at once, without reading a reply. grpc-dart then
speaks h2c or TLS over it; `setOption(tcpNoDelay)`, `address` work (real TCP socket). Proxy down → direct connect,
no measurable added latency on loopback (ECONNREFUSED < 1 ms). The head and the first payload often arrive in one
chunk (preface, or a 517-byte ClientHello): the proxy must split at `\r\n\r\n`.

**TLS trust is the hard limit.** grpc-dart builds a new `SecurityContext(withTrustedRoots: true)` (or one with
only the app's pinned certs), so our CA in `SecurityContext.defaultContext` is never used
(`CERTIFICATE_VERIFY_FAILED` measured). No Dart-level hook reaches a fresh context (`secure_socket_patch.dart`
204–247; no zone / IOOverrides / HttpOverrides lookup). Where `withTrustedRoots` reads roots (sdk 3.13.5):
- macOS **and iOS** (`globals.h` 122–124): OS SecTrust (`security_context_macos.cc` 168–186, 296–317). A root added
  with `xcrun simctl keychain <udid> add-root-cert` should be trusted on the simulator — **not tested**.
- Android: only `/system/etc/security/cacerts` (`security_context_linux.cc` 43–53); user CAs are ignored, so it
  needs a writable-system emulator image.
- Linux: system bundle files / directories, then compiled-in roots.

**ClientHello.** SNI = host (or `authority`; IP literals are sent as SNI too), ALPN `["grpc-exp","h2"]`.

**Other stacks.** connectrpc `io.dart` (HTTP/1 via `HttpClient`) is intercepted today. connectrpc `http2.dart`:
h2c uses `Socket.connect` (hookable with a second frame string); TLS uses `SecureSocket.connect` → `RawSocket`, no
override → not interceptable. App-supplied `ClientTransportConnector`s bypass us.

## Proxy side

**Silent tunnel into mockttp: works.** Our existing CONNECT takeover (`installConnectHook`, intercept-proxy.ts)
recognises the marker, runs the LAN / auth checks, writes nothing, and injects the socket the way mockttp's own
`handleH1Connect` does after its 200 (minus the 200): set `SocketTimingInfo.tunnelSetupTimestamp`,
`LastTunnelAddress = host:port`, `LastHopEncrypted = false` (Symbols from `mockttp/dist/util/socket-extensions` —
must be the same module instance), `unshift` the rest, `raw.emit('connection', socket)`. httpolyglot re-sniffs:
`PRI *` → h2 server, TLS → MITM. Requests arrive as `2.0 POST https|http://host:port/pkg.Service/Method`. The marker
must never go upstream. Passthrough hosts reuse `runTunnel`.

**ALPN / blast radius** (normal and silent CONNECT):

| Client offer | `http2: false` | `'fallback'` | `true` |
|---|---|---|---|
| Chrome `[h2, http/1.1]` | h1 | h1 | **h2** |
| Dart `HttpClient` (no ALPN) | h1 | h1 | h1 |
| grpc-dart `[grpc-exp, h2]` | `grpc-exp` → re-sniffed h2 | h2 | h2 |

→ one instance, `http2: 'fallback'`. `true` would move Flutter Web to h2 under h1-assuming code.

**mockttp's passthrough is not enough.** TLS h2 upstream: streaming / trailers / cancel / deadline work, but
trailers-only errors lose END_STREAM (`flags=5` forwarded as `flags=4`) → client sees `13 RST_STREAM code 0`. h2c
upstream: `502 Parse Error: Expected HTTP/` on every call (http2-wrapper has no h2c).

**Our own `node:http2` relay inside a mockttp step: works** for TLS and h2c with `http2` false / fallback / true,
gzip on and off: trailers-only `14` preserved, 3 MB each way, server-stream gaps ~100 ms (no buffering), bidi
round trips 0–2 ms, upstream sees the 500 ms deadline and the cancel (`RST_STREAM 8`). Raw stream API both sides
(`pipe` for backpressure, `respond(h, {endStream: true})` for trailers-only, `waitForTrailers` + `sendTrailers`).
Compat-layer glue: `down.removeAllListeners('wantTrailers')` first (else `ERR_HTTP2_TRAILERS_ALREADY_SENT`), and
mark `res.writableEnded` afterwards (else mockttp logs "finished without ending"). The step uses the own-`handle`
trick `replayStreamStep` already uses. Upstream sessions: `http2.connect(origin, {createConnection})` over a socket
from `openTunnelUpstream()` (LAN SSRF guard, upstream proxy, emulator aliases) + `tls.connect({socket,
ALPNProtocols: ['h2']})`. VS Code (1.141) patches `http`/`https`/`net`/`tls` but not `http2`, and its net/tls
patches only add system certificates — the upstream proxy and the LAN guard are ours to apply (they are, via
`createConnection`).

**Observability: works in the relay** (mockttp's `response` event and taps don't see raw-stream bytes). A side
`'data'` listener parses `[flag][len BE32][payload]` without delaying anything; records: request headers, each
request message, response headers (`trailersOnly`), each response message, trailers, upstream close (RST code),
closed — with ms offsets. `grpc-encoding: gzip` decoded. mockttp's `abort` still fires on cancel.

**Mocks / faults.** mockttp built-ins are partly usable (`thenReply` with trailers hangs on h2; `grpc-status` in
headers → `13`; a bidi callback waits for the whole request). Our handlers work: trailers-only error
(`14 mock unavailable`), a streaming mock with delay and gaps (`m1@303ms m2@504ms m3@706ms m4@906ms status=0`),
a bidi mock that answers before the client half-closes.

## Risks to design for

- **Reconnect storm.** grpc-dart treats an accepted-then-dropped connection as connected-then-lost and retries hard
  (1300 reconnects in 30 s with a bad token; 215 in 5 s against any accept-and-drop server, no override). The proxy
  must never just close a silent tunnel: answer h2 streams with trailers-only `grpc-status: 14` + GOAWAY (not
  possible for TLS passthrough). Plus a client-side breaker: ≥ 3 tunnels to one authority within 2 s → direct for
  30 s.
- **Tunnelled connect timeout.** A blackholed target hung ≥ 30 s through the tunnel; the proxy must honour
  `Flutter-Intercept-Connect-Timeout` and fail the streams with `14`.
- **TLS gRPC default:** metadata only (SNI, target, bytes, timing) unless the OS trusts our CA.
- **mockttp internals:** `server.server`, the socket-extension Symbols, the compat `wantTrailers` / `writableEnded`
  workarounds → pin mockttp, startup self-check.
- **Upstream h2 sessions:** GOAWAY, max concurrent streams, idle handling; client PINGs end at the proxy.
- **Frame parser:** cap copying for huge messages (keep counting); only gzip decoded.
- **Other (non-gRPC) h2 traffic** still uses mockttp's passthrough: h2c 502, trailers-only lost.
- Not wired in the spike: throttling (`pace.ts`), breakpoints, gRPC-Web.
- Physical devices: the target resolves on the Mac, not the device.
- Not run: Flutter device builds, IPv6 targets, Dart SDKs older than 3.13, extension-host Node versions
  (`ALPNCallback` path needs Node ≥ 20.4).

## Open decision (owner)

How to handle TLS gRPC with default credentials, which is most production-style gRPC:
1. **Metadata only** by default (passthrough, safe), full view for h2c and for apps that already trust us.
2. Plus an **opt-in "trust our CA on the iOS simulator"** (`simctl keychain add-root-cert`, removed at session end):
   untested, touches the simulator's trust store → needs its own spike and security review.
3. Android full TLS view needs a writable-system emulator: document only.

## As built — proxy (0.10.0)

Files: `packages/proxy/src/grpc.ts` (framing, bounded message parser, gzip/deflate decode capped at 16 MB per message,
`grpc-message` / `grpc-timeout` / connect-timeout parsing, first-byte classification, truncate cutter; since
REVIEW-10 prefix-only streaming decompression, see below),
`grpc-upstream.ts` (HTTP/2 session pool), `silent.ts` (self-check + injection into mockttp), changes in
`intercept-proxy.ts`, `lan.ts`, `tunnel.ts`, `rules.ts`, `index.ts`. Tests: `test/grpc.test.ts` with node:http2
client/server helpers in `test/grpc-helpers.ts` (no `@grpc/grpc-js`, no new dependency).

- mockttp runs with `http2: 'fallback'`; measured: `[h2, http/1.1]` and `[http/1.1]` → h1, `[h2]` and
  `[grpc-exp, h2]` → h2.
- Silent CONNECT: handled in `onConnect` before the passthrough check, for HTTP/1 CONNECTs only. Nothing is ever
  written back. The first payload chunk is read with a `data` listener, put back with `unshift`, and
  `readableFlowing = null` restored (as node does after a CONNECT) before the next reader. h2c preface (a partial
  prefix counts) → injected; TLS + `grpcDecryptHosts` match and not `tlsPassthrough` → injected; other TLS →
  `runTunnel` in silent mode (`grpcTunnel: true`, refusals close, connect timeout from the header); anything else →
  closed, `error` tunnel. Nothing within 30 s or a close before the first byte → closed, not recorded.
- LAN gate: a silent CONNECT refused for its token, peer or target is closed (no 407/403/400). SSRF refusals are
  recorded as before; bad-token refusals are not (unauthenticated peers can't write to the exchange list).
- HTTP/2 socket proxies: h2c sessions over an injected socket sit on a JSStreamSocket whose `.stream` is the raw
  socket, TLS ones on a TLSSocket whose `_parent` is — both were already found by the LAN guard's socket walk. Added:
  `SOCKET_SELF` on gate sockets and `session.socket` in the walk (`findOnSocketChain`), so an `Http2Session` (what
  mockttp hands its agent lookup for non-gRPC h2) resolves to its gate too.
- Relay: a `CallbackStep` with an own `handle` (route `grpc`, placed before the LAN deny rule). Request bytes are read
  from mockttp's compat request (piped through an observer, then `PacedStream` for `uploadKbps`) — a `data` listener
  before the pipe would lose bytes while the upstream session opens. Response: observer → `PacedStream` (kbps) → the
  raw stream with `waitForTrailers`; trailers-only kept as one HEADERS frame. After the response ends while the app is
  still sending, the app's stream gets RST_STREAM NO_ERROR (RFC 7540 §8.1; without it a bidi call whose server ended
  first never closes on the client).
- Failures: before response headers → trailers-only `14` `Flutter Intercept: <reason>`; an upstream RST mid-response →
  the same code to the app (state `error`); the server's connection failing mid-response → trailers `14`; the server
  ending without trailers → empty trailers (the client maps it), state `error`.
- Upstream sessions key: origin, LAN gate, TLS verify flag, client-certificate pattern, upstream proxy, alias.
  Connect timeout covers TCP / upstream-proxy CONNECT / TLS / h2 preface; on timeout everything opened is destroyed
  (also when it completes late). Max concurrent streams from the server's SETTINGS; GOAWAY takes the session out of
  the pool; idle 30 s.
- Rules: `matchRule` gets `grpc: true`; non-applicable actions (and GraphQL-scoped rules) are skipped with a note;
  `grpcMock` never matches non-gRPC requests (a grpcMock sequence step on HTTP passes through with a note).
  `setRules` "refuses" an invalid grpcMock by disabling it and listing it in `refusedRules` (throwing would drop
  every rule of a shared file); `ruleProblem` reports the same text for editors and agents.
- Self-check (`grpcSupport()`): socket-extension Symbols, own-`handle` steps kept by `StepLookup`, the compat
  `stream` getter, the combo server and our CONNECT hook. Verified inside an esbuild bundle (one module instance).
- Not done / known: gRPC-Web; breakpoints, mutate, rewrite, script, cors, mapRemote and replay on gRPC; non-gRPC
  HTTP/2 still uses mockttp's passthrough (h2c upstream 502, trailers-only lost). Replay never answers gRPC, but its
  `fail` fallback answers gRPC calls no rule matched with `14` "DNS lookup failed" (like the offline profile).
- **REVIEW-10 fixes (CONTRACTS §16.8).**
  - #1: a silent passthrough tunnel cut by a block rule, a fault, the offline profile, `replay: fail` or a throttle
    drop is held at once. The server is not contacted and nothing is relayed. The app's bytes are read and dropped
    until it closes (`simulated: "<label> (held without an answer; the app gave up after N s)"`) or
    `breakpointTimeoutMs` passes (then reset). Non-silent tunnels are unchanged.
  - Breaker reports: a `Flutter-Intercept-Tunnel: breaker` CONNECT gets the gate's checks and is never answered. It
    records no exchange, not even a gate SSRF refusal. The proxy emits `'grpcBreaker' {authority, viaLan}` (exported
    `GRPC_BREAKER_EVENT`, `GrpcBreakerEvent`) at most once per normalised authority per 60 s, and tracks at most 1000
    authorities.
  - #3: compressed messages keep ≤ 256 KB of wire bytes. `GrpcFrameRecorder` decompresses that prefix with
    `createGunzip` / `createInflate`, stops after 64 KB + 1 of output and delivers frames in order. When it stops
    early the frame has `sizeUnknown` and the wire size. Frames that finish after the call ended still join the stored
    exchange. Measured: 1000 gzip bombs (16 KB → 16 MB each) cost ≈ 24 ms of event-loop time in total (≈ 4 ms per
    message before).
  - #6: gRPC calls get the REVIEW-8 client-certificate Origin refusal (trailers-only `14`, state `blocked`). The
    "Flutter Intercept:" prefix now appears exactly once (`fiText`). `grpcMock.code` was already limited to 0–16.

## As built — proxy (0.11.0)

CONTRACTS §17.1–17.4 and §17.7. Tests: `packages/proxy/test/grpc-parity.test.ts` (node:http2 helpers from 0.10).

- **Transform** (`GrpcMessageTransform`, `grpc.ts`): replaces the observer link of a direction only when that
  direction has a hook. Request: `breakpoint` request / both. Response: breakpoint response / both, or `mutate`.
  Without a hook the 0.10 observer stays, with no per-message copies; `grpcTransformStats.created` lets the tests check
  that. A hooked transform buffers one message (≤ 4 MB of wire bytes) and calls the hook. Until the hook settles,
  the transform's callback isn't called, so HTTP/2 flow control pushes back. Larger messages stream through with a
  note and are recorded by the 0.10 parser. A bad flag byte switches that direction to raw passthrough.
- **Breakpoints**:
  - Compressed messages are decompressed for the pause (off-loop, capped at 4 MB). An unedited resume forwards the
    original wire bytes; an edit goes out uncompressed.
  - One pause at a time per call (`pauseChain`), each with its own `breakpointTimeoutMs` deadline. The other
    direction keeps flowing unless it is also waiting for a pause.
  - The status pause runs in `wantTrailers` (after the last response message) or before a trailers-only respond.
  - `abort` → RST_STREAM CANCEL both ways. The app leaving settles the pause as gone (the exchange is `aborted`).
  - Held bytes are counted globally (64 MB, then pauses are skipped with a note).
  - `resume` validates with `grpcEditProblem` (`rules.ts`, pure, exported for the host) plus the exact 4 MB check.
- **Mutate**: `setGrpcCodec(codec?)`, then `decode` → `applyOps` (`maxTargets` as HTTP) → `encode`. Any miss forwards
  the original with a note (`mutate: no schema for <path>`, or `mutate: <encode error>`). The replacement is recorded
  with `edited: true`; `simulated` reads `Mutated: <paths>`.
- **Replay**: `ReplayStore` keeps gRPC entries by path and never serves them to HTTP lookups. Not replayed: entries
  with `incomplete: true` (not in the type; read defensively) and entries with a truncated or `sizeUnknown` response
  frame. The response is built by the shared `grpcAnswer` (grpcMock is the same code). The status trailers carry the
  recorded `grpc-status` / `grpc-message` / custom trailers; `grpc-encoding` and other wire headers are not sent.
  **requestHash** = sha256 hex of the first request message's recorded frame bytes (decompressed, ≤ 64 KB, i.e.
  `base64` decoded). It is exported as `grpcMessageHash`, so the recorder must hash the same bytes. The proxy waits
  for the first request message only when several entries share the path and some carry a hash.
