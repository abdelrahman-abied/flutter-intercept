// Server-sent events test client for @flutter-intercept/proxy — dart:io only, no pub dependencies.
//
//   sse_client <proxyPort> <url>
//
// Configured like the generated entry (findProxy through the proxy, badCertificateCallback => true). Reads the
// response as a stream, the way an SSE client does, and prints as things arrive:
//   "HEADERS <ms> <status> <content-type>"  when the response head arrives
//   "CHUNK <ms> <json string>"               for every body chunk
//   "END <ms>"                               when the stream ends
// <ms> = milliseconds since the request was sent. On failure: "ERROR <type>: <message>"; exit 2.
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  final proxyPort = int.parse(args[0]);
  final url = Uri.parse(args[1]);
  final client = HttpClient()
    ..findProxy = ((_) => 'PROXY 127.0.0.1:$proxyPort')
    ..badCertificateCallback = ((_, __, ___) => true);
  final sw = Stopwatch()..start();
  try {
    final req = await client.getUrl(url);
    req.headers.set('accept', 'text/event-stream');
    final res = await req.close();
    stdout.writeln('HEADERS ${sw.elapsedMilliseconds} ${res.statusCode} ${res.headers.contentType}');
    await for (final chunk in res.transform(utf8.decoder)) {
      stdout.writeln('CHUNK ${sw.elapsedMilliseconds} ${jsonEncode(chunk)}');
    }
    stdout.writeln('END ${sw.elapsedMilliseconds}');
    await stdout.flush();
    client.close();
    exit(0);
  } catch (e) {
    stdout.writeln('ERROR ${e.runtimeType}: $e');
    await stdout.flush();
    exit(2);
  }
}
