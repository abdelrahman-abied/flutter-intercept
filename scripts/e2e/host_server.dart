// Tiny development server on this machine, for the demo app's `local_health` request
// (samples/demo_app/lib/api/local_api.dart) and the proxy's localhost rewrite (CONTRACTS §9.2).
//
//   dart run scripts/e2e/host_server.dart [--port 8787]
//   flutter run ... --dart-define=LOCAL_PORT=8787        (the app GETs http://<host>:8787/health)
//
// The app uses 10.0.2.2 on the Android emulator and localhost elsewhere (LOCAL_HOST overrides).
// Listens on 127.0.0.1 only, so on the emulator only the proxy's 10.0.2.2 -> 127.0.0.1 rewrite (or
// the emulator's own alias, without the proxy) reaches it. Answers every path with JSON and logs
// `HOST_REQ <method> <path> host=<Host header>` lines.
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  var port = 8787;
  for (var i = 0; i < args.length; i++) {
    if (args[i] == '--port') port = int.parse(args[++i]);
  }
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
  stdout.writeln('HOST_READY http://127.0.0.1:${server.port}');
  await for (final req in server) {
    stdout.writeln('HOST_REQ ${req.method} ${req.uri} host=${req.headers.host}:${req.headers.port}');
    await req.drain<void>();
    req.response
      ..headers.contentType = ContentType.json
      ..write(jsonEncode({'ok': true, 'from': 'host_server', 'path': req.uri.path, 'host': req.headers.value('host')}));
    await req.response.close();
  }
}
