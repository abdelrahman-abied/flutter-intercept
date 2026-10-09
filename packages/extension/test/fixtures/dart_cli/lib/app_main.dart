import 'dart:io';

import 'fetch.dart';

// `void main() async` under lib/: imported as package:dart_cli/app_main.dart and must NOT be awaited.
void main() async {
  await fetchAndPrint(Platform.environment['FIXTURE_URL']!, 'lib/app_main');
}
