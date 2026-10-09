// Test client for @flutter-intercept/proxy — dart:io only, no pub dependencies.
//
//   dart run dart_client.dart <proxyPort> <url> [method] [body] [timeoutMs]
//
// Configured exactly like the generated entry (CONTRACTS §1): findProxy 'PROXY ...; DIRECT' and
// badCertificateCallback => true. Set DART_CLIENT_STRICT_TLS=1 to keep certificate checks on
// (simulates an app that pins certificates). Set DART_CLIENT_PROXY to replace the proxy spec, e.g.
// `flutter-intercept:<token>@192.168.0.10:<port>` for LAN mode (proxyPort is then ignored), and
// DART_CLIENT_NO_DIRECT=1 to drop the `; DIRECT` fallback.
//
// Output: "STATUS <code>" line, then the (auto-decompressed) body; exit 0.
// On failure: "ERROR <type>: <message>"; exit 2. A timeout aborts the request like Dio's
// receiveTimeout does, then prints "ERROR TimeoutException: ...".
import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  if (args.length < 2) {
    stderr.writeln('usage: dart_client.dart <proxyPort> <url> [method] [body] [timeoutMs]');
    exit(64);
  }
  final proxyPort = int.parse(args[0]);
  final url = Uri.parse(args[1]);
  final method = args.length > 2 ? args[2].toUpperCase() : 'GET';
  final body = args.length > 3 && args[3].isNotEmpty ? args[3] : null;
  final timeout = Duration(milliseconds: args.length > 4 ? int.parse(args[4]) : 20000);
  final strictTls = Platform.environment['DART_CLIENT_STRICT_TLS'] == '1';

  final proxySpec = Platform.environment['DART_CLIENT_PROXY'] ?? '127.0.0.1:$proxyPort';
  final direct = Platform.environment['DART_CLIENT_NO_DIRECT'] == '1' ? '' : '; DIRECT';
  final client = HttpClient()..findProxy = ((_) => 'PROXY $proxySpec$direct');
  if (!strictTls) client.badCertificateCallback = ((_, __, ___) => true);

  HttpClientRequest? request;
  try {
    request = await client.openUrl(method, url).timeout(timeout);
    if (body != null) {
      final bytes = utf8.encode(body);
      request.headers.contentType = ContentType('text', 'plain', charset: 'utf-8');
      request.contentLength = bytes.length;
      request.add(bytes);
    }
    final response = await request.close().timeout(timeout);
    final text = await response.transform(utf8.decoder).join().timeout(timeout);
    stdout.writeln('STATUS ${response.statusCode}');
    stdout.write(text);
    await stdout.flush();
    client.close();
    exit(0);
  } on TimeoutException catch (e) {
    request?.abort(e);
    client.close(force: true);
    stdout.writeln('ERROR TimeoutException: ${e.message ?? 'timed out'}');
    await stdout.flush();
    exit(2);
  } catch (e) {
    client.close(force: true);
    stdout.writeln('ERROR ${e.runtimeType}: $e');
    await stdout.flush();
    exit(2);
  }
}
