// Test client for mutate rules — dart:io only, configured like the generated entry (CONTRACTS §1).
//
//   dart run mutate_client.dart <proxyPort> <url>
//
// GETs <url> through the proxy, then reads the JSON like a json_serializable model would:
//   STATUS <code>
//   BODY <body on one line>
//   AVATAR <value> | AVATAR_ERROR <error>      (json['avatar_url'] as String)
//   PRICE <value>  | PRICE_ERROR <error>       (json['price'] as double)
//   ID <value>     | ID_ERROR <error>          (json['id'] as int)
import 'dart:convert';
import 'dart:io';

void field(String label, Object? Function() read) {
  try {
    stdout.writeln('$label ${read()}');
  } catch (e) {
    stdout.writeln('${label}_ERROR $e');
  }
}

Future<void> main(List<String> args) async {
  final client = HttpClient()
    ..findProxy = ((_) => 'PROXY 127.0.0.1:${args[0]}; DIRECT')
    ..badCertificateCallback = ((_, __, ___) => true);
  try {
    final request = await client.getUrl(Uri.parse(args[1]));
    final response = await request.close();
    final text = await response.transform(utf8.decoder).join();
    stdout.writeln('STATUS ${response.statusCode}');
    stdout.writeln('BODY ${text.replaceAll('\n', ' ')}');
    final json = jsonDecode(text) as Map<String, dynamic>;
    field('AVATAR', () => json['avatar_url'] as String);
    field('PRICE', () => json['price'] as double);
    field('ID', () => json['id'] as int);
    await stdout.flush();
    client.close();
    exit(0);
  } catch (e) {
    client.close(force: true);
    stdout.writeln('ERROR ${e.runtimeType}: $e');
    await stdout.flush();
    exit(2);
  }
}
