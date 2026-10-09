import 'dart:io';

import 'package:dart_cli/fetch.dart';

Future<void> main() async {
  await fetchAndPrint(Platform.environment['FIXTURE_URL']!, 'bin/noargs');
}
