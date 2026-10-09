// Fault measurement client for @flutter-intercept/proxy — dart:io only, no pub dependencies.
//
//   dart run fault_client.dart <proxyPort> <url> [timeoutMs]
//
// Configured like the generated entry (CONTRACTS §1): findProxy 'PROXY 127.0.0.1:<port>; DIRECT' and
// badCertificateCallback => true, so a failure that made Dart fall back to DIRECT would be visible
// (the request would reach the upstream without the proxy).
//
// Prints ONE JSON line: {"phase", "type", "message", "status", "bytes", "ms"}.
// phase = where it ended: "open" (openUrl: connecting / CONNECT / TLS to the proxy), "close" (sending the
// request, waiting for the response head), "body" (reading the body), or "done" (success).
// The timeout applies to the whole exchange, like Dio's receiveTimeout or http's `.timeout()`.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  final proxyPort = int.parse(args[0]);
  final url = Uri.parse(args[1]);
  final timeout = Duration(milliseconds: args.length > 2 ? int.parse(args[2]) : 20000);
  final client = HttpClient()
    ..findProxy = ((_) => 'PROXY 127.0.0.1:$proxyPort; DIRECT')
    ..badCertificateCallback = ((_, __, ___) => true);
  final sw = Stopwatch()..start();
  var phase = 'open';
  int? status;
  var bytes = 0;
  HttpClientRequest? request;
  void out(String type, String message) {
    stdout.writeln(jsonEncode({
      'phase': phase,
      'type': type,
      'message': message,
      'status': status,
      'bytes': bytes,
      'ms': sw.elapsedMilliseconds,
    }));
  }

  final deadline = Timer(timeout, () {
    request?.abort(TimeoutException('timed out', timeout));
  });
  try {
    request = await client.openUrl('GET', url).timeout(timeout);
    phase = 'close';
    final response = await request.close();
    status = response.statusCode;
    phase = 'body';
    await for (final chunk in response) {
      bytes += chunk.length;
    }
    phase = 'done';
    out('ok', '');
  } catch (e) {
    final msg = e.toString();
    out(e.runtimeType.toString(), msg.length > 300 ? msg.substring(0, 300) : msg);
  } finally {
    deadline.cancel();
    client.close(force: true);
  }
  await stdout.flush();
  exit(0);
}
