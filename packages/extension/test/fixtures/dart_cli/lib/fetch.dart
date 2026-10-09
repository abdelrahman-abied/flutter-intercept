import 'dart:convert';
import 'dart:io';

/// Plain dart:io request — no proxy configuration in the app.
Future<void> fetchAndPrint(String url, String tag) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse(url));
    final response = await request.close();
    final body = await response.transform(utf8.decoder).join();
    final via = response.headers.value('x-test-proxy') ?? 'none';
    print('FIXTURE_RESPONSE[$tag] status=${response.statusCode} via=$via body=$body');
  } catch (e) {
    print('FIXTURE_ERROR[$tag] $e');
  } finally {
    client.close();
  }
  print('FIXTURE_DONE[$tag]');
}
