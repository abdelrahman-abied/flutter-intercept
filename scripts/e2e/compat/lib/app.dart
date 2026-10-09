// "App" for the entry-template compatibility harness. dart:io only, written in
// language 2.12 syntax so the same file runs with every SDK/language version.
// Prints `COMPAT <case> <PASS|FAIL> <detail>`; the run script greps them.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

const users = 'https://jsonplaceholder.typicode.com/users/1';

int failures = 0;
void report(String name, bool ok, String detail) {
  if (!ok) failures++;
  print('COMPAT $name ${ok ? 'PASS' : 'FAIL'} $detail');
}

Future<String> fetch(HttpClient c, String url, {String method = 'GET'}) async {
  c.connectionTimeout = const Duration(seconds: 10);
  final req = await c.openUrl(method, Uri.parse(url)).timeout(const Duration(seconds: 20));
  final res = await req.close().timeout(const Duration(seconds: 20));
  final body = await res.transform(utf8.decoder).join();
  return '${res.statusCode} $body';
}

bool intercepted(String r) => r.contains('"_intercepted":true');

Future<void> check(String name, Future<String> Function() run, bool Function(String) ok) async {
  try {
    final r = await run();
    final one = r.replaceAll(RegExp(r'\s+'), ' ');
    report(name, ok(r), one.length > 120 ? one.substring(0, 120) : one);
  } catch (e) {
    final s = '$e'.replaceAll(RegExp(r'\s+'), ' ');
    report(name, false, 'ERR ${s.length > 160 ? s.substring(0, 160) : s}');
  }
}

class AppOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)..userAgent = 'app-global-overrides';
}

Future<void> main() async {
  print('COMPAT_START dart=${Platform.version.split(' ').first}');

  // Reviewer's attack: a self-signed CN=evil.example server must never be accepted,
  // whether the request goes through the proxy or falls back to DIRECT.
  final evil = Platform.environment['FI_EVIL_URL'];
  if (evil != null) {
    await check('attack_self_signed_rejected', () async {
      try {
        return 'ACCEPTED ${await fetch(HttpClient(), evil)}';
      } catch (e) {
        return 'rejected: $e';
      }
    }, (r) => r.startsWith('rejected: ') || (!r.contains('"evil":true') && !r.startsWith('ACCEPTED 200')));
  }
  if (Platform.environment['FI_ONLY_ATTACK'] == '1') {
    // Proxy down: the app's own pinning must keep its meaning on the DIRECT fallback.
    final pins = Platform.environment['FI_PINS'];
    if (pins != null) {
      HttpClient pinned() => HttpClient(
          context: SecurityContext(withTrustedRoots: false)..setTrustedCertificates(pins));
      await check('direct_pinned_context_allows_pinned_root', () => fetch(pinned(), users),
          (r) => r.startsWith('200 ') && !intercepted(r));
      await check('direct_pinned_context_rejects_other_roots', () async {
        try {
          return 'ACCEPTED ${await fetch(pinned(), 'https://letsencrypt.org/')}';
        } catch (e) {
          return 'rejected: $e';
        }
      }, (r) => r.startsWith('rejected: ') && r.contains('CERTIFICATE_VERIFY_FAILED'));
    }
    if (evil != null) {
      await check('direct_app_callback_false_rejects', () async {
        try {
          final c = HttpClient()..badCertificateCallback = (cert, host, port) => false;
          return 'ACCEPTED ${await fetch(c, evil)}';
        } catch (e) {
          return 'rejected: $e';
        }
      }, (r) => r.startsWith('rejected: '));
      // An app that itself accepts any certificate keeps doing so (its own choice, as without the tool).
      await check('direct_app_callback_true_is_the_apps_choice', () async {
        final c = HttpClient()..badCertificateCallback = (cert, host, port) => cert.subject.contains('evil.example');
        return fetch(c, evil);
      }, (r) => r.contains('"evil":true'));
    }
    print('COMPAT_DONE failures=$failures');
    return;
  }

  await check('plain', () => fetch(HttpClient(), users), intercepted);

  await check('charles_findProxy', () {
    final c = HttpClient()..findProxy = (u) => 'PROXY 127.0.0.1:8888';
    return fetch(c, users);
  }, intercepted);

  await check('env_findProxy', () {
    final c = HttpClient()..findProxy = HttpClient.findProxyFromEnvironment;
    return fetch(c, users);
  }, intercepted);

  await check('pin_badCertificateCallback', () {
    final c = HttpClient()..badCertificateCallback = (cert, host, port) => false;
    return fetch(c, users);
  }, intercepted);

  final pins = Platform.environment['FI_PINS'];
  if (pins != null) {
    await check('pin_securityContext', () {
      final ctx = SecurityContext(withTrustedRoots: false)..setTrustedCertificates(pins);
      return fetch(HttpClient(context: ctx), users);
    }, intercepted);
  }

  await check('forwarded_fields', () async {
    final c = HttpClient()
      ..idleTimeout = const Duration(seconds: 7)
      ..connectionTimeout = const Duration(seconds: 9)
      ..maxConnectionsPerHost = 3
      ..autoUncompress = true
      ..userAgent = 'compat-ua';
    final fields = '${c.idleTimeout.inSeconds},${c.connectionTimeout!.inSeconds},'
        '${c.maxConnectionsPerHost},${c.autoUncompress},${c.userAgent}';
    final r = await fetch(c, 'https://httpbin.org/get');
    return '$fields $r';
  }, (r) => r.startsWith('7,9,3,true,compat-ua') && r.contains('"User-Agent":"compat-ua"') && intercepted(r));

  await check('methods_post_put_delete_head', () async {
    final c = HttpClient();
    final out = <String>[];
    for (final f in <Future<HttpClientRequest> Function()>[
      () => c.postUrl(Uri.parse('https://jsonplaceholder.typicode.com/posts')),
      () => c.putUrl(Uri.parse('https://jsonplaceholder.typicode.com/posts/1')),
      () => c.patchUrl(Uri.parse('https://jsonplaceholder.typicode.com/posts/1')),
      () => c.deleteUrl(Uri.parse('https://jsonplaceholder.typicode.com/posts/1')),
      () => c.headUrl(Uri.parse('https://jsonplaceholder.typicode.com/posts/1')),
      () => c.get('httpbin.org', 80, '/get'),
    ]) {
      final req = await f();
      final res = await req.close();
      await res.drain<void>();
      out.add('${req.method}:${res.statusCode}');
    }
    c.close();
    return out.join(' ');
  }, (r) => r == 'POST:201 PUT:200 PATCH:200 DELETE:200 HEAD:200 GET:200');

  await check('callback_setters', () async {
    final c = HttpClient();
    c.authenticate = (url, scheme, realm) async => false;
    c.authenticateProxy = (host, port, scheme, realm) async => false;
    c.keyLog = (line) {};
    c.addCredentials(Uri.parse(users), 'r', HttpClientBasicCredentials('u', 'p'));
    c.addProxyCredentials('localhost', 1, 'r', HttpClientBasicCredentials('u', 'p'));
    c.connectionFactory = (uri, proxyHost, proxyPort) =>
        Socket.startConnect(proxyHost ?? uri.host, proxyPort ?? uri.port);
    return fetch(c, users);
  }, intercepted);

  await check('close_then_use', () async {
    final c = HttpClient();
    await fetch(c, users);
    c.close(force: true);
    try {
      await c.getUrl(Uri.parse(users));
      return 'no error after close';
    } catch (e) {
      return 'closed: ${e.runtimeType}';
    }
  }, (r) => r.startsWith('closed: '));

  await check('app_global_overrides_kept', () async {
    HttpOverrides.global = AppOverrides();
    final c = HttpClient();
    final ua = c.userAgent;
    final r = await fetch(c, users);
    return 'ua=$ua $r';
  }, (r) => r.startsWith('ua=app-global-overrides') && intercepted(r));

  print('COMPAT_DONE failures=$failures');
}
