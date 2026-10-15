// Mutual TLS (Flutter Intercept 0.14.0): Dio with the app's own client certificate, the way apps that talk to an
// mTLS API do it. Server: `node scripts/e2e/mtls_server.mjs` on the development machine. Plain app code, no
// interception code.
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

/// `--dart-define=MTLS_PORT=n`: the server's strict port (n + 1 = the nginx-style port). With it, an mTLS batch runs
/// after the first request batch (and after every hot restart): `DEMO_MTLS start` … `DEMO_MTLS done <n>`.
const mtlsPort = int.fromEnvironment('MTLS_PORT');

/// `--dart-define=MTLS_P12=<base64>` / `MTLS_PASS=<passphrase>`: the app's client certificate (PKCS#12), as an app
/// would bundle it. `MTLS_CA=<base64 PEM>`: the server's CA (a private CA, as mTLS APIs often use).
const _p12 = String.fromEnvironment('MTLS_P12');
const _pass = String.fromEnvironment('MTLS_PASS');
const _ca = String.fromEnvironment('MTLS_CA');

String get mtlsHost => Platform.isAndroid ? '10.0.2.2' : 'localhost';

Dio? _dio;
Dio get _mtlsDio => _dio ??= Dio()
  ..httpClientAdapter = IOHttpClientAdapter(
    createHttpClient: () {
      final ctx = SecurityContext(withTrustedRoots: true)
        ..setTrustedCertificatesBytes(base64.decode(_ca))
        ..useCertificateChainBytes(base64.decode(_p12), password: _pass)
        ..usePrivateKeyBytes(base64.decode(_p12), password: _pass);
      return HttpClient(context: ctx);
    },
  );

/// The two mTLS calls: label → (status, body).
final Map<String, Future<(int, Object?)> Function()> mtlsCalls = {
  'mtls_strict': () => _get(mtlsPort, '/whoami'),
  'mtls_nginx': () => _get(mtlsPort + 1, '/whoami'),
};

Future<(int, Object?)> _get(int port, String path) async {
  final r = await _mtlsDio.get<Object?>('https://$mtlsHost:$port$path');
  return (r.statusCode ?? -1, r.data);
}
