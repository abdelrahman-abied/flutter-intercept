# Spike — template v3: trust a per-install CA instead of accepting any certificate

Date 2026-10-08 · Flutter 3.47.6 / Dart 3.13.5 · Agent A · fixes REVIEW-1 #1 (HIGH) and #2 (MED)

## Verdict: **fixed.**

### REVIEW-1 #1 (HIGH)
The v2 entry accepted **any** certificate, including on the `; DIRECT` fallback. On the
iOS simulator with the proxy down, v2 accepted the reviewer's self-signed `CN=evil.example`
server: `DEMO_RESULT attack 200 {"evil":true}`.

v3 no longer accepts arbitrary certificates. Instead:
- The extension generates a **per-install CA** once, with a random subject. It is stored in
  `globalStorageUri` with file mode 0600 and passed to the proxy.
- The entry embeds only the CA **certificate** and **trusts** it: on
  `SecurityContext.defaultContext` and on any context the app supplies.
- So proxy certificates pass normal chain and hostname verification, and DIRECT traffic is
  verified exactly as it would be without Flutter Intercept.
- The app's own `badCertificateCallback` is forwarded unchanged. The entry installs no
  callback of its own.

With the proxy down, the attack server now fails with `CERTIFICATE_VERIFY_FAILED` in every
setup tested:
- Dart VM, on 5 SDKs × 2 language versions.
- Android emulator, with adb reverse kept, with adb reverse removed, and with `10.0.2.2`.
- iOS simulator.

With the proxy up, interception still works in every app mode, including Charles, env and
the pinning modes.

### REVIEW-1 #2 (MED)
- **Device-independent content.** The entry no longer bakes in the proxy host. Flutter
  sessions get `--dart-define=FLUTTER_INTERCEPT_PROXY=<host>:<port>`. Plain-Dart sessions
  use the baked default `localhost:<port>`.
- **No flavor collisions.** The file name comes from the full project-relative path
  (`lib/flavors/dev/main.dart` → `entry_lib__flavors__dev__main.dart`), with a hash suffix
  when the mapping is lossy.

## Attack evidence (before / after)

The attack server is `scripts/e2e/evil_server.dart`: HTTPS, self-signed `CN=evil.example`,
always answers `{"evil":true}`. The app GETs it with a plain package:http client (demo
`EVIL_URL`, label `attack`).

| Where | Proxy | v2 (before) | v3 (after) |
|---|---|---|---|
| iOS simulator | down | ❌ `attack 200 ms=306 {"evil":true}` (**accepted**) | ✅ `attack ERR HandshakeException: ... CERTIFICATE_VERIFY_FAILED: application verification failure` |
| Android emulator | down, adb reverse **kept** | — | ✅ `attack ERR HandshakeException: ... CERTIFICATE_VERIFY_FAILED: self signed certificate` |
| Android emulator | down, adb reverse **removed** | — | ✅ same |
| Android emulator (`10.0.2.2`, never reversed) | down | — | ✅ same |
| Dart VM (macOS), compat harness | down | ❌ `attack_self_signed_rejected FAIL ACCEPTED 200 {"evil":true}` | ✅ `PASS rejected: HandshakeException ... CERTIFICATE_VERIFY_FAILED` on 3.0.0 / 3.3.0 / 3.6.0 / 3.9.0 / 3.13.5 × language 2.12 / 3.0 |
| Dart VM, extension unit test (real `InterceptProxy`) | down | — | ✅ `proxy down: the DIRECT fallback rejects a self-signed server` |
| All of the above | up | 502 from the proxy (the proxy verifies upstream) | ✅ `attack 502 proxy error: ... CERTIFICATE_VERIFY_FAILED`, never `{"evil":true}` |

**Negative control.** If the entry trusts a different CA from the one the proxy signs with,
the TLS handshake to the proxy fails. Dart then falls back to **verified** DIRECT, so the
request is not intercepted and nothing insecure happens. Measured in two places:
- VM: `plain 200 {"name":"Leanne Graham"...}`, real data.
- Unit test: `proxy up but signing with a different CA: the app does not trust it`.

**Does iOS honour the added root? Yes.** The iOS note in `security_context.dart` ("DER
only") is stale. With the PEM passed to `setTrustedCertificatesBytes`, the iOS simulator
accepted proxy leaves and rejected the self-signed server in every v3 run. The macOS Dart
VM shares the same Apple verification path ("application verification failure") and
behaves the same way.

**Clock skew matters.** The first Android run failed every HTTPS interception (silently
DIRECT). The cause: the emulator clock was 17 s behind the host, and the test proxy minted
leaves with `notBefore = now`. The test proxy now backdates leaves by one day; mockttp
already does this for the real proxy's leaves and CA.

## Device results with v3 (`scripts/e2e/run_device.sh <dev> --attack [...]`, all ALL PASSED)

Each debug run checks the following:
- **Proxy up:** the whole batch is intercepted (Dio, http, POST, gzip, plain http, mock,
  block), plus the attack (502).
- **After hot restart:** the same checks again.
- **Proxy down:** the app works DIRECT (on Android, first with adb reverse kept, then with
  it removed), and the attack fails with CERTIFICATE_VERIFY_FAILED.

| Mode | Android emulator (API 36.1) | iOS simulator (iPhone 17 Pro) |
|---|---|---|
| default | ✅ 34 checks | ✅ 28 |
| `APP_FINDPROXY=charles` | ✅ 35 (note `ignored app findProxy`) | ✅ 29 |
| `APP_FINDPROXY=env` | ✅ 35 | ✅ 29 |
| `APP_PINNING=callback` | ✅ 34, intercepted | ✅ 28 |
| `APP_PINNING=context` (`withTrustedRoots: false`) | ✅ 34, intercepted | ✅ 28 |
| `APP_PINNING=dio_validate` | ✅ 34: Dio requests fail `DioException [bad certificate]` (residual, unchanged), http intercepted | ✅ 28 |
| `--emulator-host` (`10.0.2.2`, no reverse) | ✅ 28 | n/a |
| `lib/main_dev.dart --profile --emulator-host` | ✅ 12 (AOT) | n/a |
| `APP_SETS_OVERRIDES=true` | ✅ 34 | ✅ 28 (with `main_dev`) |

## What happens to app pinning now

| App code | Proxy up | Proxy down (DIRECT) |
|---|---|---|
| `badCertificateCallback = (c, h, p) => <pin check>` | Intercepted. The proxy leaf is trusted, so the callback is never consulted. | The app's callback, unchanged. It is consulted only for untrusted certificates, exactly as without the tool. VM: `direct_app_callback_false_rejects PASS rejected` |
| An app callback that itself accepts the certificate | Intercepted | The app's own choice is kept (`direct_app_callback_true_is_the_apps_choice`: `{"evil":true}`), identical to running without the tool. The tool adds nothing. |
| `SecurityContext(withTrustedRoots: false)` + pinned roots | Intercepted. Our CA is added to that context. | Pinning enforced: a pinned root passes (`direct_pinned_context_allows_pinned_root 200`), another root fails (`direct_pinned_context_rejects_other_roots ... CERTIFICATE_VERIFY_FAILED`, letsencrypt.org / ISRG). The output is identical to the same program run **without** the entry (baseline run). |
| Dio `validateCertificate` (leaf pin) | ❌ Dio rejects the proxy leaf (residual limit, as in v2) | ✅ works |
| A context the app builds inside its own `HttpOverrides` delegate | Fails closed: TLS to the proxy fails → verified DIRECT (not intercepted) | ✅ app semantics |

Remaining trust surface: the app trusts this machine's CA, but only in sessions launched
through the entry (debug/profile; release launches are never rewritten). The CA key is a
0600 file on the developer machine, so trusting the CA only matters to someone who already
has that file.

## Template v3

The source of truth is `scripts/e2e/templates/entry_v3.dart.tmpl`. It is identical to
CONTRACTS §1 and to `ENTRY_TEMPLATE` in `packages/extension/src/entry/generator.ts`; a unit
test asserts the CONTRACTS ↔ generator part.

```dart
// GENERATED by Flutter Intercept. Do not edit. Safe to delete.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '{{TARGET_IMPORT}}' as target; // package:<app>/<path> when under lib/, else relative

// Flutter sessions pass --dart-define=FLUTTER_INTERCEPT_PROXY=<host:port> (device dependent);
// the default serves plain Dart sessions, which run on the host and take no dart-define.
const _proxyAddress = String.fromEnvironment('FLUTTER_INTERCEPT_PROXY', defaultValue: 'localhost:{{PROXY_PORT}}');
const _proxy = 'PROXY $_proxyAddress; DIRECT';

String _findProxy(Uri url) => _proxy;

// Certificate of this machine's Flutter Intercept CA (its private key never leaves the
// development machine). It is *trusted* in addition to the normal roots, so the proxy's
// per-host certificates pass ordinary chain + hostname verification, and DIRECT traffic
// (proxy unreachable) is verified exactly as without Flutter Intercept.
const _caCertificate = r'''
{{CA_CERT_PEM}}''';

final Expando<bool> _trustedContexts = Expando<bool>();
void _trustCa(SecurityContext context) {
  if (_trustedContexts[context] == true) return;
  _trustedContexts[context] = true;
  try {
    context.setTrustedCertificatesBytes(utf8.encode(_caCertificate));
  } catch (e) {
    // Already present (e.g. CERT_ALREADY_IN_HASH_TABLE) is fine. Otherwise interception of
    // this context's HTTPS fails closed: the TLS handshake fails and Dart falls back to DIRECT.
    if (!'$e'.contains('ALREADY')) _note('could not trust the Flutter Intercept CA: $e');
  }
}

final Set<String> _noted = <String>{};
void _note(String message) {
  if (_noted.add(message)) print('[flutter_intercept] $message');
}

class _FlutterInterceptOverrides extends HttpOverrides {
  _FlutterInterceptOverrides(this._previous);
  final HttpOverrides? _previous;
  bool _creating = false;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    // Re-entered from a delegate that calls HttpClient() itself: give it a
    // plain client; the outer call configures and wraps it.
    if (_creating) return super.createHttpClient(context);
    _trustCa(context ?? SecurityContext.defaultContext);
    // Our zone value shadows any HttpOverrides.global the app installs later;
    // delegate to it so the app's own overrides still apply underneath ours.
    final global = Zone.root.run(() => HttpOverrides.current);
    final delegate = (global != null && !identical(global, this)) ? global : _previous;
    HttpClient client;
    if (delegate != null) {
      _creating = true;
      try {
        client = delegate.createHttpClient(context);
      } finally {
        _creating = false;
      }
    } else {
      client = super.createHttpClient(context);
    }
    if (client is _InterceptedHttpClient) return client;
    client.findProxy = _findProxy;
    return _InterceptedHttpClient(client);
  }
}

/// Forwards every member to the real client, except that app assignments to
/// `findProxy` made after creation (Charles-style snippets,
/// findProxyFromEnvironment) are ignored so traffic stays on the proxy.
/// `badCertificateCallback` is the app's own (forwarded): it is never consulted
/// for proxy certificates, which are trusted, and keeps its meaning on DIRECT.
/// Callback setters take `dynamic` so their exact function types can never
/// mismatch the SDK; members added by future SDKs reach `noSuchMethod`.
class _InterceptedHttpClient implements HttpClient {
  _InterceptedHttpClient(this._client);
  final HttpClient _client;

  @override
  set findProxy(dynamic f) {
    if (f != null) _note('ignored app findProxy (requests stay on the intercept proxy)');
  }

  @override
  set badCertificateCallback(dynamic callback) => _client.badCertificateCallback = callback;

  @override
  set connectionFactory(dynamic f) {
    if (f != null) _note('app set connectionFactory: its connections may bypass the intercept proxy');
    _client.connectionFactory = f;
  }

  @override
  Duration get idleTimeout => _client.idleTimeout;
  @override
  set idleTimeout(Duration value) => _client.idleTimeout = value;
  @override
  Duration? get connectionTimeout => _client.connectionTimeout;
  @override
  set connectionTimeout(Duration? value) => _client.connectionTimeout = value;
  @override
  int? get maxConnectionsPerHost => _client.maxConnectionsPerHost;
  @override
  set maxConnectionsPerHost(int? value) => _client.maxConnectionsPerHost = value;
  @override
  bool get autoUncompress => _client.autoUncompress;
  @override
  set autoUncompress(bool value) => _client.autoUncompress = value;
  @override
  String? get userAgent => _client.userAgent;
  @override
  set userAgent(String? value) => _client.userAgent = value;

  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) =>
      _client.open(method, host, port, path);
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => _client.openUrl(method, url);
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => _client.get(host, port, path);
  @override
  Future<HttpClientRequest> getUrl(Uri url) => _client.getUrl(url);
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => _client.post(host, port, path);
  @override
  Future<HttpClientRequest> postUrl(Uri url) => _client.postUrl(url);
  @override
  Future<HttpClientRequest> put(String host, int port, String path) => _client.put(host, port, path);
  @override
  Future<HttpClientRequest> putUrl(Uri url) => _client.putUrl(url);
  @override
  Future<HttpClientRequest> delete(String host, int port, String path) =>
      _client.delete(host, port, path);
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => _client.deleteUrl(url);
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) =>
      _client.patch(host, port, path);
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => _client.patchUrl(url);
  @override
  Future<HttpClientRequest> head(String host, int port, String path) => _client.head(host, port, path);
  @override
  Future<HttpClientRequest> headUrl(Uri url) => _client.headUrl(url);

  @override
  set authenticate(dynamic f) => _client.authenticate = f;
  @override
  void addCredentials(Uri url, String realm, HttpClientCredentials credentials) =>
      _client.addCredentials(url, realm, credentials);
  @override
  set authenticateProxy(dynamic f) => _client.authenticateProxy = f;
  @override
  void addProxyCredentials(String host, int port, String realm, HttpClientCredentials credentials) =>
      _client.addProxyCredentials(host, port, realm, credentials);
  @override
  set keyLog(dynamic callback) => _client.keyLog = callback;
  @override
  void close({bool force = false}) => _client.close(force: force);

  // Only reached for HttpClient members added by a future SDK (all members of
  // Dart 3.0-3.13 are forwarded above). Setters are dropped (the app keeps
  // working with the SDK default); getters/methods cannot be forwarded.
  @override
  dynamic noSuchMethod(Invocation invocation) {
    _note('HttpClient member ${invocation.memberName} is not supported by this Flutter Intercept version'
        '${invocation.isSetter ? ' (assignment ignored)' : ''}');
    if (invocation.isSetter) return null;
    return super.noSuchMethod(invocation);
  }
}

Future<void> main(List<String> args) async {
  _trustCa(SecurityContext.defaultContext);
  final overrides = _FlutterInterceptOverrides(HttpOverrides.current);
  HttpOverrides.global = overrides;
  // Zone value wins over a later `HttpOverrides.global = ...` inside the app.
  await HttpOverrides.runWithHttpOverrides(() async {
    // Works for `void main()`, `Future<void> main() async` and `main(List<String>)`.
    final dynamic entry = target.main;
    final dynamic result = entry is Function(List<String>) ? entry(args) : entry();
    if (result is Future) await result;
  }, overrides);
}
```

Diff from v2:

```diff
@@ -1,13 +1,36 @@
 // GENERATED by Flutter Intercept. Do not edit. Safe to delete.
 import 'dart:async';
+import 'dart:convert';
 import 'dart:io';
 import '{{TARGET_IMPORT}}' as target; // package:<app>/<path> when under lib/, else relative
 
-const _proxy = 'PROXY {{PROXY_HOST}}:{{PROXY_PORT}}; DIRECT';
+// Flutter sessions pass --dart-define=FLUTTER_INTERCEPT_PROXY=<host:port> (device dependent);
+// the default serves plain Dart sessions, which run on the host and take no dart-define.
+const _proxyAddress = String.fromEnvironment('FLUTTER_INTERCEPT_PROXY', defaultValue: 'localhost:{{PROXY_PORT}}');
+const _proxy = 'PROXY $_proxyAddress; DIRECT';
 
 String _findProxy(Uri url) => _proxy;
-bool _acceptCertificate(X509Certificate cert, String host, int port) => true;
 
+// Certificate of this machine's Flutter Intercept CA (its private key never leaves the
+// development machine). It is *trusted* in addition to the normal roots, so the proxy's
+// per-host certificates pass ordinary chain + hostname verification, and DIRECT traffic
+// (proxy unreachable) is verified exactly as without Flutter Intercept.
+const _caCertificate = r'''
+{{CA_CERT_PEM}}''';
+
+final Expando<bool> _trustedContexts = Expando<bool>();
+void _trustCa(SecurityContext context) {
+  if (_trustedContexts[context] == true) return;
+  _trustedContexts[context] = true;
+  try {
+    context.setTrustedCertificatesBytes(utf8.encode(_caCertificate));
+  } catch (e) {
+    // Already present (e.g. CERT_ALREADY_IN_HASH_TABLE) is fine. Otherwise interception of
+    // this context's HTTPS fails closed: the TLS handshake fails and Dart falls back to DIRECT.
+    if (!'$e'.contains('ALREADY')) _note('could not trust the Flutter Intercept CA: $e');
+  }
+}
+
 final Set<String> _noted = <String>{};
 void _note(String message) {
   if (_noted.add(message)) print('[flutter_intercept] $message');
@@ -23,6 +46,7 @@
     // Re-entered from a delegate that calls HttpClient() itself: give it a
     // plain client; the outer call configures and wraps it.
     if (_creating) return super.createHttpClient(context);
+    _trustCa(context ?? SecurityContext.defaultContext);
     // Our zone value shadows any HttpOverrides.global the app installs later;
     // delegate to it so the app's own overrides still apply underneath ours.
     final global = Zone.root.run(() => HttpOverrides.current);
@@ -39,16 +63,16 @@
       client = super.createHttpClient(context);
     }
     if (client is _InterceptedHttpClient) return client;
-    client
-      ..findProxy = _findProxy
-      ..badCertificateCallback = _acceptCertificate;
+    client.findProxy = _findProxy;
     return _InterceptedHttpClient(client);
   }
 }
 
 /// Forwards every member to the real client, except that app assignments to
-/// `findProxy` and `badCertificateCallback` made after creation (Charles-style
-/// snippets, certificate pinning) are ignored so traffic stays interceptable.
+/// `findProxy` made after creation (Charles-style snippets,
+/// findProxyFromEnvironment) are ignored so traffic stays on the proxy.
+/// `badCertificateCallback` is the app's own (forwarded): it is never consulted
+/// for proxy certificates, which are trusted, and keeps its meaning on DIRECT.
 /// Callback setters take `dynamic` so their exact function types can never
 /// mismatch the SDK; members added by future SDKs reach `noSuchMethod`.
 class _InterceptedHttpClient implements HttpClient {
@@ -61,11 +85,7 @@
   }
 
   @override
-  set badCertificateCallback(dynamic callback) {
-    if (callback != null) {
-      _note('ignored app badCertificateCallback (certificate checks are relaxed while intercepting)');
-    }
-  }
+  set badCertificateCallback(dynamic callback) => _client.badCertificateCallback = callback;
 
   @override
   set connectionFactory(dynamic f) {
@@ -154,6 +174,7 @@
 }
 
 Future<void> main(List<String> args) async {
+  _trustCa(SecurityContext.defaultContext);
   final overrides = _FlutterInterceptOverrides(HttpOverrides.current);
   HttpOverrides.global = overrides;
   // Zone value wins over a later `HttpOverrides.global = ...` inside the app.
```

## Compatibility (3.0–3.13, `scripts/e2e/compat/run_compat.sh`)

| SDK | language 2.12 | language 3.0 |
|---|---|---|
| 3.0.0 | ✅ failures=0 (12 cases + attack 502) | ✅ |
| 3.3.0 | ✅ | ✅ |
| 3.6.0 | ✅ | ✅ |
| 3.9.0 | ✅ | ✅ |
| 3.13.5 | ✅ | ✅ |

The same matrix with the proxy down (`FI_PROXY_DOWN=1`): `attack_self_signed_rejected PASS
rejected: ... CERTIFICATE_VERIFY_FAILED` on all 10. `Expando`, `utf8`, raw strings and
const interpolation are all available at language 2.12. The `HttpClient` member list is
unchanged from v2, which was verified identical across 3.0–3.13.

## Extension changes

| File | Change |
|---|---|
| `src/ca.ts` (new) | `loadOrCreateCa` / `CaStore`. Uses mockttp's `generateCACertificate` (already bundled for the proxy, loaded lazily); random CN `Flutter Intercept CA <16 hex>`; writes `flutter-intercept-ca.json` 0600 (dir 0700). Creation is atomic `link`, so concurrent windows converge. Regenerates when invalid, not a CA, key ≠ cert, or expiring within 30 days. Resets the mode to 0600 if the file was loosened. |
| `src/proxyHost.ts` | `getCa` option; the same CA is passed to every `InterceptProxy({ ca })` start. |
| `src/extension.ts` | `CaStore(context.globalStorageUri)` wired into the proxy host and the provider. Saved rules go through `validateRules` (lead request). |
| `src/entry/generator.ts` | v3 template; `entryNameFor` uses the full relative path plus a hash when lossy; `renderEntry({ targetImport, proxyPort, caCertPem })` accepts exactly one CERTIFICATE block; `writeEntry` refuses an entry without the CA; `PROXY_DEFINE`. |
| `src/debug/rewrite.ts` | `caCertPem` in the context; Flutter sessions get `withInterceptDefines(sha, host:port)`; restore strips both defines. |
| `src/debug/provider.ts` | First pass without the CA (decides only); after `proxyHost.start()`, rewrites with the CA certificate. |
| tests | `ca.test.ts` (new); `generator.test.ts` adds real-dart trust tests (proxy down rejects the attack, proxy up with this CA intercepts a mock, different CA not trusted); `rewrite.test.ts` covers device-independent content and flavor names; `proxyHost.test.ts` covers CA wiring. Integration suites: entry names updated, plus a `FLUTTER_INTERCEPT_PROXY` define check in `devices.ts`. |

Results:
- `npm test`: **138/138**.
- `vsce package` succeeded; `test:bundle` passes.
- Packaged-extension suites: Dart **39/39** and Flutter (macOS) **3/3**. Devices: see
  "Extension device suite" below.

## Residual limits / notes
- Dio `validateCertificate` pinning (unchanged; see template-v2.md).
- If a Flutter session somehow loses the `FLUTTER_INTERCEPT_PROXY` define, it uses
  `localhost:<port>`. That is correct for the iOS simulator and for Android with adb reverse,
  and safe otherwise (verified DIRECT).
- The test proxy (`scripts/e2e/mitm_proxy.dart --ca`) mints leaves with Homebrew OpenSSL ≥ 3.4
  for backdating. Without it (LibreSSL) leaves start "now", which fails on lagging device
  clocks.
- I imported mockttp's `generateCACertificate` from the extension directly instead of adding
  a proxy export. A `generateCa()` export from `@flutter-intercept/proxy` would be tidier
  (lead/Agent C).
