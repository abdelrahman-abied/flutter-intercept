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
