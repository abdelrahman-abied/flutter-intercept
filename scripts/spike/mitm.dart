import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  final dir = args.first;
  final ctx = SecurityContext()
    ..useCertificateChain('$dir/cert.pem')
    ..usePrivateKey('$dir/key.pem');

  // TLS terminator: sees decrypted requests
  final tls = await HttpServer.bindSecure('127.0.0.1', 8900, ctx);
  final upstream = HttpClient();
  tls.listen((req) async {
    final host = req.headers.host!;
    final url = Uri.https(host, req.uri.path, req.uri.queryParameters.isEmpty ? null : req.uri.queryParameters);
    print('PROXY saw: ${req.method} $url');
    if (req.uri.path.startsWith('/blocked')) {
      req.response..statusCode = 403..write('{"blocked":true}');
      return req.response.close();
    }
    final up = await (await upstream.openUrl(req.method, url)).close();
    final body = jsonDecode(await up.transform(utf8.decoder).join()) as Map;
    print('PROXY real name from server: ${body['name']}');
    body['name'] = 'EDITED BY TOOL';
    req.response
      ..statusCode = up.statusCode
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(body));
    await req.response.close();
  });

  // Plain proxy port: answers CONNECT then pipes bytes into the TLS terminator
  final server = await ServerSocket.bind('127.0.0.1', PORT_PLACEHOLDER);
  server.listen((client) async {
    Socket? tunnel;
    final buf = <int>[];
    client.listen((data) async {
      if (tunnel != null) return tunnel!.add(data);
      buf.addAll(data);
      final head = latin1.decode(buf);
      if (!head.contains('\r\n\r\n')) return;
      tunnel = await Socket.connect('127.0.0.1', 8900);
      tunnel!.listen(client.add, onDone: client.destroy);
      client.add(latin1.encode('HTTP/1.1 200 Connection established\r\n\r\n'));
    }, onDone: () => tunnel?.destroy());
  });
  print('proxy ready');
}
