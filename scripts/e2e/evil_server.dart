// The reviewer's attack server: HTTPS with a self-signed certificate for
// CN=evil.example (no SAN), answering every request with {"evil":true}.
// A correctly verifying client must fail with CERTIFICATE_VERIFY_FAILED.
//   dart run scripts/e2e/evil_server.dart --port 8443 --dir <certdir>
import 'dart:io';

Future<void> main(List<String> argv) async {
  var port = 8443;
  var dir = '${Directory.systemTemp.path}/fi_evil';
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] == '--port') port = int.parse(argv[++i]);
    if (argv[i] == '--dir') dir = argv[++i];
  }
  Directory(dir).createSync(recursive: true);
  if (!File('$dir/evil.pem').existsSync()) {
    final r = await Process.run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=evil.example',
      '-keyout', '$dir/evil.key', '-out', '$dir/evil.pem',
    ]);
    if (r.exitCode != 0) throw StateError('openssl: ${r.stderr}');
  }
  final ctx = SecurityContext()
    ..useCertificateChain('$dir/evil.pem')
    ..usePrivateKey('$dir/evil.key');
  final server = await HttpServer.bindSecure(InternetAddress.anyIPv4, port, ctx);
  server.listen((req) async {
    stdout.writeln('EVIL_HIT ${req.method} ${req.uri} from ${req.connectionInfo?.remoteAddress.address}');
    req.response
      ..headers.contentType = ContentType.json
      ..write('{"evil":true}');
    await req.response.close();
  }, onError: (Object e) => stdout.writeln('EVIL_TLS_ERROR $e'));
  stdout.writeln('EVIL_READY port=$port');
}
