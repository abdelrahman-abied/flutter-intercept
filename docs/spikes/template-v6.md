# Spike — template v6: gRPC `Socket.connect` hook

Date 2026-10-11 · Flutter 3.47.7 / Dart 3.13.5 (+ Dart 3.0.0 / 3.3.0 compile + run) · grpc-dart 5.1.0, protobuf 6.1.0,
protoc_plugin 25.1.0 · macOS 27 arm64 host · Agent D · CONTRACTS §16.1 (spike: docs/spikes/grpc.md)

## Verdict: works on every device tried

| | macOS desktop | iOS simulator (iOS 27.0) | Android emulator (API 36, arm64) | plain Dart (VM) |
|---|---|---|---|---|
| unary / server / client / bidi streaming through a silent tunnel (h2c) | ✅ | ✅ | ✅ (proxy via adb reverse and via 10.0.2.2) | ✅ |
| `NOT_FOUND` status + trailers unchanged | ✅ | ✅ | ✅ | ✅ |
| TLS gRPC (app trusts the server's self-signed cert) through a silent tunnel (`first=tls`) | ✅ | ✅ | ✅ | ✅ |
| HTTP batch (Dio, http, gzip, plain http, mock, block, traces) unchanged | ✅ | ✅ | ✅ | ✅ (unit tests) |
| `Isolate.run` gRPC call after `flutterInterceptInstall` at PauseStart | ✅ | ✅ | ✅ | – (`vm.isolates.real.test.ts` passes on v6) |
| … without the install (v5 behaviour: no overrides in the isolate) | direct ✅ | – | direct ✅ | – |
| hot restart (`R`): new tunnels, same results | ✅ | ✅ | ✅ | n/a |
| proxy down → direct (ECONNREFUSED, no added latency measured) | ✅ | ✅ | ✅ | ✅ |
| `FLUTTER_INTERCEPT_GRPC=0` → direct, no silent CONNECT | ✅ | ✅ | – | ✅ |
| no proxy define (plain Dart session) → direct | – | – | – | ✅ |
| circuit breaker (≥ 3 tunnels in 2 s → direct 30 s, one note) | – | – | ✅ stale adb reverse (below) | ✅ |

"Through the tunnel" is proven, not inferred: the test server answers with `servedTo` (the client address:port of the
TCP connection it served) and the stand-in proxy logs the local port of each silent tunnel's upstream connection
(`PROXY_SILENT <authority> first=h2c via=<port>`). `run_device.sh` checks that the ports match (tunnel) or don't
(direct) for every call.

## What v6 adds (diff from v5)

`scripts/e2e/templates/entry_v6.dart.tmpl` = `ENTRY_TEMPLATE` (`src/entry/generator.ts`, `ENTRY_TEMPLATE_VERSION = 6`).
v6 = v5 + the block below (inserted before the install function) + one line in `_install()`:

```dart
  HttpOverrides.global = overrides;
  _installIO();
  return _installed = overrides;
```

```dart
// gRPC (CONTRACTS §16.1). grpc-dart, and connectrpc's HTTP/2 transport, open their connection with a plain
// Socket.connect, which HttpOverrides never sees. Those connects (recognised by the library's frame on the
// stack) go to the proxy instead, through a "silent" CONNECT: the proxy never answers it and relays or decodes
// what follows. Every other connect goes direct, exactly as without Flutter Intercept. Off with
// --dart-define=FLUTTER_INTERCEPT_GRPC=0 and in sessions without the proxy define (plain Dart).
const _grpcEnabled =
    String.fromEnvironment('FLUTTER_INTERCEPT_GRPC') != '0' && bool.hasEnvironment('FLUTTER_INTERCEPT_PROXY');
const _grpcFrames = <String>[
  'package:grpc/src/client/http2_connection.dart',
  'package:connectrpc/src/http2/connection.dart',
];
// Connecting to the proxy takes at most 2 s (or the app's connectTimeout if shorter), then the call goes direct.
const _grpcHopTimeout = Duration(seconds: 2);
// grpc-dart reconnects at once when an accepted connection drops: after 3 tunnels to one authority within
// 2 s, that authority goes direct for 30 s (per isolate).
const _grpcBurstTunnels = 3;
const _grpcBurstMs = 2000;
const _grpcDirectMs = 30000;

// IOOverrides.global before ours: direct connects go through it (null: the SDK's own).
IOOverrides? _ioPrevious;
// A scope that overrides nothing: the SDK's own behaviour, for the hop to the proxy.
IOOverrides? _ioPlain;
final Map<String, List<int>> _grpcTunnels = <String, List<int>>{};
final Map<String, int> _grpcDirectUntil = <String, int>{};

// Not a subclass (IOOverrides is `abstract base`, and a `base`/`final` subclass does not parse in apps on a
// pre-3.0 language version): a scope from IOOverrides.runZoned is a ready-made IOOverrides. Installed as the
// global only, never in a zone, so that an IOOverrides.global the app sets later still takes effect.
void _installIO() {
  if (!_grpcEnabled) return;
  final previous = Zone.root.run(() => IOOverrides.current);
  try {
    IOOverrides.global = null;
    _ioPlain = Zone.root.run(() => IOOverrides.runZoned(() => IOOverrides.current!));
    IOOverrides.global = previous;
    final ours = Zone.root.run(() => IOOverrides.runZoned(() => IOOverrides.current!, socketConnect: _grpcConnect));
    _ioPrevious = previous;
    IOOverrides.global = ours;
  } catch (e) {
    IOOverrides.global = previous;
    _note('gRPC calls are not intercepted ($e)');
  }
}

Future<Socket> _grpcConnect(dynamic host, int port, {dynamic sourceAddress, int sourcePort = 0, Duration? timeout}) {
  final unix = host is InternetAddress && host.type == InternetAddressType.unix;
  if (unix || !_grpcCaller()) return _grpcDirect(host, port, sourceAddress, sourcePort, timeout);
  return _grpcTunnel(host, port, sourceAddress, sourcePort, timeout);
}

bool _grpcCaller() {
  final stack = StackTrace.current.toString();
  for (final frame in _grpcFrames) {
    if (stack.contains(frame)) return true;
  }
  return false;
}

Future<Socket> _grpcDirect(dynamic host, int port, dynamic sourceAddress, int sourcePort, Duration? timeout) {
  return IOOverrides.runWithIOOverrides(
      () => Socket.connect(host, port, sourceAddress: sourceAddress, sourcePort: sourcePort, timeout: timeout),
      _ioPrevious ?? _ioPlain!);
}

// FLUTTER_INTERCEPT_PROXY is [user:token@]host:port (the host may be an [IPv6] literal).
String _grpcProxyHost() {
  final hostPort = _proxyAddress.substring(_proxyAddress.indexOf('@') + 1);
  final host = hostPort.substring(0, hostPort.lastIndexOf(':'));
  return host.startsWith('[') && host.endsWith(']') ? host.substring(1, host.length - 1) : host;
}

int _grpcProxyPort() => int.parse(_proxyAddress.substring(_proxyAddress.lastIndexOf(':') + 1));

String _grpcProxyAuthorization() {
  final at = _proxyAddress.indexOf('@');
  if (at < 0) return '';
  return 'Proxy-Authorization: Basic ${base64Encode(utf8.encode(_proxyAddress.substring(0, at)))}\r\n';
}

// Tells the proxy that the breaker sent this authority direct (CONTRACTS §16.8): one more connection that carries
// only a `breaker` head, then is closed. Best effort: never awaited by the app's connect, errors swallowed.
void _grpcBreakerReport(String authority) {
  Zone.root.run(() {
    try {
      final head = 'CONNECT $authority HTTP/1.1\r\n'
          'Host: $authority\r\n'
          'Flutter-Intercept-Tunnel: breaker\r\n'
          '${_grpcProxyAuthorization()}'
          '\r\n';
      final proxyHost = _grpcProxyHost();
      final proxyPort = _grpcProxyPort();
      IOOverrides.runWithIOOverrides(
              () => Socket.connect(proxyHost, proxyPort, timeout: _grpcHopTimeout), _ioPlain!)
          .then((Socket socket) {
        socket.done.then((Object? v) => null, onError: (Object e) => null);
        socket.add(utf8.encode(head));
        return socket.flush().whenComplete(socket.destroy);
      }).then((Object? v) => null, onError: (Object e) => null);
    } catch (_) {
      // Malformed proxy define: nothing to report to.
    }
  });
}

Future<Socket> _grpcTunnel(dynamic host, int port, dynamic sourceAddress, int sourcePort, Duration? timeout) async {
  final target = host is InternetAddress ? host.address : '$host';
  final authority = target.contains(':') && !target.startsWith('[') ? '[$target]:$port' : '$target:$port';
  final now = DateTime.now().millisecondsSinceEpoch;
  if ((_grpcDirectUntil[authority] ?? 0) > now) return _grpcDirect(host, port, sourceAddress, sourcePort, timeout);
  final recent = _grpcTunnels.putIfAbsent(authority, () => <int>[]);
  recent.removeWhere((int t) => now - t >= _grpcBurstMs);
  if (recent.length >= _grpcBurstTunnels) {
    recent.clear();
    _grpcDirectUntil[authority] = now + _grpcDirectMs;
    _note("gRPC connections to $authority kept closing, so the app connects directly for 30 s — Flutter Intercept "
        "rules and network simulation don't apply to them meanwhile.");
    _grpcBreakerReport(authority);
    return _grpcDirect(host, port, sourceAddress, sourcePort, timeout);
  }
  final hop = timeout != null && timeout < _grpcHopTimeout ? timeout : _grpcHopTimeout;
  final watch = Stopwatch()..start();
  Socket socket;
  String head;
  try {
    final proxyHost = _grpcProxyHost();
    final proxyPort = _grpcProxyPort();
    final authorization = _grpcProxyAuthorization();
    socket = await IOOverrides.runWithIOOverrides(
        () => Socket.connect(proxyHost, proxyPort, timeout: hop), _ioPlain!);
    final left = timeout == null ? null : timeout - watch.elapsed;
    final ms = left == null ? null : (left.inMilliseconds < 1 ? 1 : left.inMilliseconds);
    head = 'CONNECT $authority HTTP/1.1\r\n'
        'Host: $authority\r\n'
        'Flutter-Intercept-Tunnel: silent\r\n'
        '${ms == null ? '' : 'Flutter-Intercept-Connect-Timeout: $ms\r\n'}'
        '$authorization'
        '\r\n';
  } catch (_) {
    // Proxy unreachable: connect direct with what is left of the app's timeout.
    final left = timeout == null ? null : timeout - watch.elapsed;
    if (left != null && left <= Duration.zero) rethrow;
    return _grpcDirect(host, port, sourceAddress, sourcePort, left);
  }
  recent.add(now);
  // No reply is ever read: the app's HTTP/2 (h2c or TLS) follows the head on the same connection.
  socket.add(utf8.encode(head));
  return socket;
}
```

Notes:
- **Global only, not a subclass.** `IOOverrides.runZoned(() => IOOverrides.current!, socketConnect: …)` from the root
  zone returns a ready-made `IOOverrides`. An app's later `IOOverrides.runZoned(createFile: …)` keeps our
  `socketConnect` either way: Dart 3.3+ copies the outer scope's functions and `_previous` into the new scope, 3.0
  chains to the outer scope as `_previous`. The plain scope
  (`_ioPlain`) is built while the global is briefly `null`, so the hop to the proxy never re-enters our hook. Direct
  connects go through the previous global (`_ioPrevious`) or `_ioPlain`, never back through ours (a delegate to the
  current global could loop when the app wraps ours).
- **Only `Socket.connect`** (grpc-dart's `SocketTransportConnector.initSocket`, connectrpc's h2c connection).
  `HttpClient` / `WebSocket` use `Socket.startConnect` and are not affected (unit test: `HttpClient` through the
  proxy unchanged on every SDK).
- **Silent CONNECT head** byte-exact (unit-tested): `Flutter-Intercept-Connect-Timeout` carries what is left of the
  app's `connectTimeout` after the hop (the demo's 10 s → `9973`–`9999`), absent without one. Proxy authorization is
  the raw `user:token` of the define (same as Dart's `HttpClient` proxy credentials).
- **Breaker**: a tunnel counts once the hop connected; the 4th connect to an authority with 3 tunnels in the last
  2 s trips it (that connect and the next 30 s go direct). One console note per authority (REVIEW-10 #1):
  `[flutter_intercept] gRPC connections to <authority> kept closing, so the app connects directly for 30 s — Flutter
  Intercept rules and network simulation don't apply to them meanwhile.`
- **Breaker report** (CONTRACTS §16.8, REVIEW-10 #1): on each trip one more connection to the proxy carrying only
  `CONNECT <authority> HTTP/1.1\r\nHost: <authority>\r\nFlutter-Intercept-Tunnel: breaker\r\n[Proxy-Authorization: …\r\n]\r\n`,
  flushed and destroyed, in the root zone, never awaited by the app's connect, every error swallowed. Unit-tested:
  byte-exact head (with and without LAN credentials), the app's direct connects stay < 500 ms, a proxy that stopped
  listening before the report → no error, no output beyond the note. `mitm_proxy.dart` logs it as `PROXY_BREAKER`.
  The device runs in the table below predate the report and the new note text (template otherwise unchanged; the
  Dart 3.0 / 3.3 / 3.13 × language 2.12 / 3.0 matrix was re-run with it). The end-to-end offline check (Android
  emulator, TLS gRPC + offline profile, held tunnels) needs the proxy change and is the lead's.
- dart:io / dart:async / dart:convert only, no new import, no records / patterns / `_` wildcards / class modifiers.

## Language versions and SDKs

Scratch matrix (fake `package:grpc` whose `lib/src/client/http2_connection.dart` calls `Socket.connect` like
grpc-dart, a TCP recorder as the proxy): the v6 entry compiles and runs on **Dart 3.0.0, 3.3.0 and 3.13.5**, in
packages with **language version 2.12 and 3.0** — gRPC connect → proxy (exact silent head), app `Socket.connect` →
direct, `HttpClient` → proxy as before. `IOOverrides.runZoned(socketConnect:)` has the same signature
(`sourcePort` included) since 3.0.

## Unit tests (`test/unit/generator.test.ts`)

- v6 verbatim = `entry_v6.dart.tmpl`; v6 minus the gRPC block and `_installIO();` = v5 exactly; v5 minus the install
  function = v4 (moved from the old v5 test). The CONTRACTS §1 comparison is skipped until §1 contains `_installIO`.
- Static: no `IOOverrides` subclass or class modifier, the hook is assigned to the global only and `main` has no
  `IOOverrides` zone, frame strings, `FLUTTER_INTERCEPT_GRPC` / proxy-define gate, the silent head literal, the tunnel
  never reads from the socket, timeouts / breaker constants; `grpcDefines()`.
- Real Dart VM (fake `package:grpc` path dependency + Node TCP listeners): exact head for a hostname, an IPv4 and an
  IPv6 `InternetAddress` (`[::1]:<port>`), remaining connect timeout, `Proxy-Authorization` from `user:token@`; the
  h2c preface follows the head on the same connection; app sockets, Unix-domain sockets, `FLUTTER_INTERCEPT_GRPC=0`
  and no proxy define go direct; `IOOverrides.runZoned(createFile:)` layered by the app keeps the hook, an app that
  replaces the global wins (no loop, no note); proxy down → direct in < 500 ms; breaker (6 connects → 3 tunnels +
  3 direct, one note; another authority unaffected); the entry analyzes and runs in a language-2.12 package.

## Devices (`scripts/e2e/run_device.sh <device> --grpc [--isolates] [--grpc-off] [--emulator-host]`)

Harness (committed): `scripts/e2e/grpc_server` (Dart, `demo.orders.v1.OrderService` on 127.0.0.1 and ::1, h2c +
TLS with a self-signed certificate minted at start into a temp dir that is deleted once loaded),
`scripts/e2e/mitm_proxy.dart` (now also accepts silent CONNECT: no reply, raw relay, `10.0.2.2` → `127.0.0.1`,
connect timeout from the header), `scripts/e2e/isolate_installer.mjs` (the extension's background-isolate install
for `flutter run --start-paused`: `invoke flutterInterceptInstall` at PauseStart, then `resume`). The demo's gRPC
batch (`GRPC_PORT` / `GRPC_TLS_PORT`) runs after the HTTP batch and after each hot restart. Stages per run: proxy up
(run1), hot restart (run2), proxy down (run3; Android with adb reverse: run3 = adb reverse kept, run4 = removed).

| Device | Mode | Result | gRPC first call (unary, incl. connect) tunnel → direct | TLS call tunnel → direct |
|---|---|---|---|---|
| macOS | default | ALL PASSED | 80 / 66 ms → 91 ms | 35 / 27 ms → 44 ms |
| macOS | `--isolates` | ALL PASSED (6× `installed`, `grpc_isolate` tunnelled, `overridesInIsolate: true`) | 131 / 72 ms → 80 ms | 36 / 34 ms → 43 ms |
| macOS | `--grpc-off` | ALL PASSED (every call direct, no `PROXY_SILENT`) | 85 / 62 ms (direct) | 40 / 28 ms |
| iOS simulator | `--isolates` | ALL PASSED (6× `installed`) | 97 / 66 ms → 72 ms | 61 / 28 ms → 43 ms |
| iOS simulator | `--grpc-off` | ALL PASSED | direct | direct |
| Android emulator | adb reverse | ALL PASSED | 194 / 110 ms → 214 ms (run4) | 42 / 40 ms → 571 ms |
| Android emulator | `--emulator-host --isolates` (the extension's mode) | ALL PASSED (6× `installed`) | 643 / 563 ms → 218 ms | 560 / 548 ms → 546 ms |

Times are single samples (`DEMO_RESULT … ms=`), noisy: other agents were building and running on the same machine.
Every new connection the emulator opens to 10.0.2.2 costs ~0.2–0.57 s whether it goes to the proxy or to the server
(direct TLS 534–571 ms, `Isolate.run` ~540 ms in every stage); adb reverse avoids it. A `tcpNoDelay` on the hop
socket made no difference (tried, not kept). Streaming calls on an open connection: 3 events at 100 ms → 207–228 ms
everywhere; bidi round trips 3–12 ms (138–144 ms on the adb-reverse emulator run).

**Stale adb reverse (proxy down, `adb reverse` left behind)**: adbd accepts the hop and drops it, so grpc-dart sees
connected-then-lost. h2c: the channel reconnected through 3 tunnels, the breaker tripped
(the then note `[flutter_intercept] gRPC to 10.0.2.2:<port> goes direct for 30 s …`) and all h2c calls succeeded (unary 189 ms).
TLS (another authority, one connection): `grpc_tls ERR … code: 14 … HandshakeException: Connection terminated during
handshake` once; fine again after `adb reverse --remove`. The extension removes its adb reverse at session end, so
this needs a crash; plain HTTP already fails in that state (CONTRACTS §2).

## Plain Dart

`dart run -DFLUTTER_INTERCEPT_PROXY=127.0.0.1:<p> <entry>` with a real grpc-dart client: unary, streaming, NOT_FOUND,
bidi through one h2c tunnel and TLS through a second (`servedTo` ports = tunnel ports); with
`-DFLUTTER_INTERCEPT_GRPC=0` all direct. Without the proxy define (how Dart-Code starts plain Dart sessions) the hook is
off by design (§16.1).

## Requested contract changes / notes for the lead

1. §1: replace the template with `scripts/e2e/templates/entry_v6.dart.tmpl` (the generator test turns the §1
   comparison on once §1 contains `_installIO`).
2. §16.1 breaker wording (§16.8 adds the report): "a connect to an authority that already had 3 tunnels in the last 2 s goes direct, and so
   does that authority for 30 s" (what is built and tested).
3. §16.1: the connect-timeout header carries the time left of the app's `connectTimeout` after the hop, not the
   original value.
4. Plain Dart sessions get no gRPC interception (no define). If wanted later, the entry could enable the hook with
   the baked `localhost:<port>` default; out of scope here.
