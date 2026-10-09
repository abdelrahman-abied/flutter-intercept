// A development server running on the developer's machine, e.g.
//   dart run scripts/e2e/host_server.dart --port 8787
// then run the app with --dart-define=LOCAL_PORT=8787. Plain app code, no interception code.
import 'dart:io';

import 'package:http/http.dart' as http;

/// `--dart-define=LOCAL_PORT=n`: also GET `http://{host}:{n}/health` (label `local_health`); 0 = off.
const localPort = int.fromEnvironment('LOCAL_PORT');

/// `--dart-define=LOCAL_HOST=host`: overrides the host. By default the way apps usually reach a
/// server on the development machine: 10.0.2.2 from the Android emulator, localhost elsewhere.
const localHostOverride = String.fromEnvironment('LOCAL_HOST');

String get localHost => localHostOverride.isNotEmpty
    ? localHostOverride
    : Platform.isAndroid
        ? '10.0.2.2'
        : 'localhost';

Uri get localHealthUrl => Uri.parse('http://$localHost:$localPort/health');

Future<http.Response> fetchLocalHealth(http.Client client) => client.get(localHealthUrl);
