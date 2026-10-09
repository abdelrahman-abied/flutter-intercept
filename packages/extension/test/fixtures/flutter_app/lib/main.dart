import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';

// Plain dart:io request, no proxy code. The URL comes from --dart-define (toolArgs in the test).
const _url = String.fromEnvironment('FIXTURE_URL');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const Center(child: Text('fixture', textDirection: TextDirection.ltr)));
  final client = HttpClient();
  try {
    final response = await (await client.getUrl(Uri.parse(_url))).close();
    final body = await response.transform(utf8.decoder).join();
    final via = response.headers.value('x-test-proxy') ?? 'none';
    print('FIXTURE_RESPONSE[flutter] status=${response.statusCode} via=$via body=$body');
  } catch (e) {
    print('FIXTURE_ERROR[flutter] $e');
  }
  print('FIXTURE_DONE[flutter]');
  await Future<void>.delayed(const Duration(milliseconds: 500));
  exit(0);
}
