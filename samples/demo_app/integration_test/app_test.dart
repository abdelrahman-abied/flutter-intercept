// A minimal on-device integration test for the headless mode (`flutter-intercept test`, packages/cli).
// Plain dart:io + package:http, no interception code: the CLI's generated entry routes the traffic.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('loads a todo with dart:io HttpClient', (tester) async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(Uri.parse('https://jsonplaceholder.typicode.com/todos/1'));
      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      expect(response.statusCode, 200);
      expect((jsonDecode(body) as Map<String, dynamic>)['id'], 1);
    } finally {
      client.close();
    }
  });

  testWidgets('loads a user with package:http', (tester) async {
    final response = await http.get(Uri.parse('https://jsonplaceholder.typicode.com/users/1'));
    expect(response.statusCode, 200);
    expect((jsonDecode(response.body) as Map<String, dynamic>)['name'], isA<String>());
  });
}
