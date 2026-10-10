// A plain networking demo: Dio + package:http + a plugin (shared_preferences).
// Contains no interception/proxy code of any kind.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/catalog_api.dart';
import 'api/local_api.dart';
import 'api/orders_api.dart';
import 'api/users_api.dart';
import 'pinned_roots.dart';

/// --dart-define=APP_SETS_OVERRIDES=true : the app installs its own
/// `HttpOverrides.global` (a pass-through that tags the User-Agent), like the
/// common "MyHttpOverrides" snippet many apps ship.
const appSetsOverrides = bool.fromEnvironment('APP_SETS_OVERRIDES');

/// --dart-define=APP_ZONE_OVERRIDES=true : the app wraps runApp in its own
/// `HttpOverrides.runWithHttpOverrides` zone.
const appZoneOverrides = bool.fromEnvironment('APP_ZONE_OVERRIDES');

/// --dart-define=REPEAT_SECONDS=n : re-run the request batch every n seconds.
const repeatSeconds = int.fromEnvironment('REPEAT_SECONDS');

/// --dart-define=APP_FINDPROXY=charles|env : the app's own HttpClient (used by
/// Dio's IOHttpClientAdapter and package:http's IOClient) sets `findProxy`
/// after creation — `charles` is the classic leftover debug snippet
/// `(uri) => 'PROXY 127.0.0.1:8888'`, `env` is `HttpClient.findProxyFromEnvironment`.
const appFindProxy = String.fromEnvironment('APP_FINDPROXY');

/// --dart-define=APP_PINNING=callback|context|dio_validate : certificate pinning.
/// `callback`: `badCertificateCallback` accepts only well-known public CAs.
/// `context`: `SecurityContext(withTrustedRoots: false)` trusting only the
/// real roots of the demo hosts. `dio_validate`: Dio's `validateCertificate`
/// checks the leaf's issuer (Dio's documented pinning hook).
const appPinning = String.fromEnvironment('APP_PINNING');

/// --dart-define=EVIL_URL=https://host:port/ : also GET this URL with a plain
/// package:http client (label `attack`). Used to check that a server with an
/// untrusted (self-signed) certificate is rejected.
const evilUrl = String.fromEnvironment('EVIL_URL');

const _customClient = appFindProxy != '' || appPinning != '';

const _publicCas = ['Google Trust Services', 'Amazon', "Let's Encrypt", 'DigiCert', 'Sectigo', 'GlobalSign'];
bool _issuerTrusted(X509Certificate? cert) =>
    cert != null && _publicCas.any((ca) => cert.issuer.contains(ca));

HttpClient appHttpClient() {
  final client = appPinning == 'context'
      ? HttpClient(
          context: SecurityContext(withTrustedRoots: false)
            ..setTrustedCertificatesBytes(utf8.encode(pinnedRootsPem)))
      : HttpClient();
  if (appFindProxy == 'charles') client.findProxy = (uri) => 'PROXY 127.0.0.1:8888';
  if (appFindProxy == 'env') client.findProxy = HttpClient.findProxyFromEnvironment;
  if (appPinning == 'callback') {
    client.badCertificateCallback = (cert, host, port) => _issuerTrusted(cert);
  }
  return client;
}

Future<http.Response> _httpGet(Uri url) =>
    _customClient ? IOClient(appHttpClient()).get(url) : http.get(url);

class AppHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)..userAgent = 'demo-app-own-overrides';
}

HttpClientAdapter _dioAdapter() => _customClient
    ? IOHttpClientAdapter(
        createHttpClient: appHttpClient,
        validateCertificate: appPinning == 'dio_validate'
            ? (cert, host, port) => _issuerTrusted(cert)
            : null,
      )
    : IOHttpClientAdapter();

BaseOptions _dioOptions() => BaseOptions(
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 20),
      validateStatus: (_) => true,
    );

final _dio = Dio(_dioOptions())..httpClientAdapter = _dioAdapter();

final _catalog = CatalogApi(Dio(_dioOptions())
  ..httpClientAdapter = _dioAdapter()
  ..interceptors.addAll([DemoClientHeaderInterceptor(), DemoAuthInterceptor()]));

// Retrofit + json_serializable models (lib/models): the app's own view of the API contract.
final _users = UsersApi(Dio(_dioOptions())..httpClientAdapter = _dioAdapter());

final _httpClient = _customClient ? IOClient(appHttpClient()) : http.Client();
final _orders = OrdersApi(_httpClient);

int _batch = 0;

void log(String line) => debugPrint(line);

String _short(Object? body) {
  String s;
  if (body is String) {
    try {
      s = jsonEncode(jsonDecode(body));
    } catch (_) {
      s = body;
    }
  } else {
    s = jsonEncode(body);
  }
  s = s.replaceAll(RegExp(r'\s+'), ' ');
  return s.length > 160 ? '${s.substring(0, 160)}...' : s;
}

Future<void> _timed(String label, Future<(int, Object?)> Function() fn) async {
  final sw = Stopwatch()..start();
  try {
    final (status, body) = await fn();
    log('DEMO_RESULT $label $status ms=${sw.elapsedMilliseconds} ${_short(body)}');
  } catch (e) {
    final msg = e.toString().replaceAll(RegExp(r'\s+'), ' ');
    log('DEMO_RESULT $label ERR ms=${sw.elapsedMilliseconds} '
        '${msg.length > 200 ? msg.substring(0, 200) : msg}');
  }
}

Future<void> dioUser() => _timed('dio_user', () async {
      // Credentials like a real app sends them (tools must show them redacted to AI agents).
      final r = await _dio.get<Object?>('https://jsonplaceholder.typicode.com/users/1',
          options: Options(headers: {'Authorization': 'Bearer demo-secret-123', 'X-Api-Key': 'demo-key-456'}));
      return (r.statusCode ?? -1, r.data);
    });

Future<void> httpTodo() => _timed('http_todo', () async {
      final r = await _httpGet(Uri.parse('https://jsonplaceholder.typicode.com/todos/1'));
      return (r.statusCode, r.body);
    });

Future<void> dioPost() => _timed('dio_post', () async {
      final r = await _dio.post<Object?>('https://jsonplaceholder.typicode.com/posts',
          data: {'title': 'hello', 'body': 'from demo', 'userId': 1});
      return (r.statusCode ?? -1, r.data);
    });

Future<void> httpGzip() => _timed('http_gzip', () async {
      final r = await _httpGet(Uri.parse('https://httpbin.org/gzip'));
      final m = jsonDecode(r.body) as Map<String, dynamic>;
      // Keep the interesting keys up front so they survive truncation.
      return (r.statusCode, {
        for (final k in m.keys.where((k) => k != 'headers')) k: m[k],
        'ua': (m['headers'] as Map?)?['User-Agent'],
      });
    });

Future<void> httpPlain() => _timed('http_plain', () async {
      final r = await _httpGet(Uri.parse('http://httpbin.org/get?plain=1'));
      if (r.statusCode != 200) return (r.statusCode, r.body);
      final m = jsonDecode(r.body) as Map<String, dynamic>;
      return (r.statusCode, {
        for (final k in m.keys.where((k) => k != 'headers')) k: m[k],
      });
    });

Future<void> dioUser2() => _timed('dio_user2', () async {
      final r = await _dio.get<Object?>('https://jsonplaceholder.typicode.com/users/2');
      return (r.statusCode ?? -1, r.data);
    });

Future<void> httpComment() => _timed('http_comment', () async {
      final r = await _httpGet(Uri.parse('https://jsonplaceholder.typicode.com/comments/1'));
      return (r.statusCode, r.body);
    });

Future<void> attack() => _timed('attack', () async {
      final r = await http.get(Uri.parse(evilUrl));
      return (r.statusCode, r.body);
    });

Future<void> catalogAlbum() => _timed('catalog_album', () async {
      final r = await _catalog.fetchAlbum(1);
      return (r.statusCode ?? -1, r.data);
    });

Future<void> ordersCreate() => _timed('orders_create', () async {
      final r = await _orders.createOrder(item: 'coffee beans', quantity: 2);
      return (r.statusCode, r.body);
    });

Future<void> retrofitUser() => _timed('retrofit_user', () async {
      // Throws (ERR "type 'Null' is not a subtype of type 'String' …") when the response breaks
      // the model, e.g. after "Make null in next responses" on `email`.
      final r = await _users.getUser(3);
      final u = r.data;
      return (r.response.statusCode ?? -1, {
        'id': u.id,
        'handle': u.handle,
        'email': u.email,
        'city': u.address.city,
        'tier': u.tier.name,
      });
    });

Future<void> localHealth() => _timed('local_health', () async {
      final r = await fetchLocalHealth(_httpClient);
      return (r.statusCode, r.body);
    });

Future<void> prefs() => _timed('prefs', () async {
      final p = await SharedPreferences.getInstance();
      final n = (p.getInt('launches') ?? 0) + 1;
      await p.setInt('launches', n);
      return (200, {'launches': n});
    });

Future<void> runBatch() async {
  _batch++;
  log('DEMO_BATCH start $_batch');
  await Future.wait([
    dioUser(),
    httpTodo(),
    dioPost(),
    httpGzip(),
    httpPlain(),
    dioUser2(),
    httpComment(),
    prefs(),
    catalogAlbum(),
    ordersCreate(),
    retrofitUser(),
    if (localPort > 0) localHealth(),
    if (evilUrl.isNotEmpty) attack(),
  ]);
  log('DEMO_BATCH done $_batch');
}

void runDemo({required String flavor}) {
  log('DEMO_START flavor=$flavor appSetsOverrides=$appSetsOverrides '
      'appZoneOverrides=$appZoneOverrides findProxy=${appFindProxy.isEmpty ? '-' : appFindProxy} '
      'pinning=${appPinning.isEmpty ? '-' : appPinning} repeat=$repeatSeconds'
      '${localPort > 0 ? ' local=$localHealthUrl' : ''}');
  if (appSetsOverrides) HttpOverrides.global = AppHttpOverrides();

  void start() {
    WidgetsFlutterBinding.ensureInitialized();
    runApp(DemoApp(flavor: flavor));
    runBatch();
    if (repeatSeconds > 0) {
      Timer.periodic(Duration(seconds: repeatSeconds), (_) => runBatch());
    }
  }

  if (appZoneOverrides) {
    HttpOverrides.runWithHttpOverrides(start, AppHttpOverrides());
  } else {
    start();
  }
}

class DemoApp extends StatelessWidget {
  const DemoApp({super.key, required this.flavor});
  final String flavor;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo ($flavor)',
      home: Scaffold(
        appBar: AppBar(title: Text('Network demo — $flavor')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final (label, fn) in [
              ('Run all requests', runBatch),
              ('Dio GET user', dioUser),
              ('http GET todo', httpTodo),
              ('Dio POST', dioPost),
              ('http GET gzip', httpGzip),
              ('http GET plain http://', httpPlain),
              ('Dio GET album (interceptors)', catalogAlbum),
              ('http POST order', ordersCreate),
              ('Retrofit GET user (models)', retrofitUser),
              if (localPort > 0) ('GET host server /health', localHealth),
            ])
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: FilledButton(onPressed: fn, child: Text(label)),
              ),
          ],
        ),
      ),
    );
  }
}
