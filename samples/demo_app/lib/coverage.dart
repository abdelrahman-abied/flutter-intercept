// Coverage scenarios (Flutter Intercept 0.5.0): traffic that is not a plain request/response,
// or that does not go through the main isolate's dart:io. Still no interception code.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'native_client.dart';

/// `--dart-define=WS_URL=…` (a ws/wss echo server) / `SSE_URL=…` (a text/event-stream URL): default the public echo server
/// (WebSocket at `/`, Server-Sent Events at `/.sse`). Tests pass a local server (rate limits).
const wsEchoUrl = String.fromEnvironment('WS_URL', defaultValue: 'wss://echo.websocket.org');
const sseUrl = String.fromEnvironment('SSE_URL', defaultValue: 'https://echo.websocket.org/.sse');
const graphqlUrl = 'https://countries.trevorblades.com/graphql';

typedef Outcome = (int, Object?);

/// WebSocket (dart:io): send a text and a binary message, wait for both echoes, close cleanly.
Future<Outcome> webSocketEcho() async {
  const text = 'hello from demo_app';
  final binary = Uint8List.fromList([0, 1, 2, 3, 254, 255]);
  final ws = await WebSocket.connect(wsEchoUrl).timeout(const Duration(seconds: 20));
  final received = <String>[];
  var gotText = false, gotBinary = false;
  final both = Completer<void>();
  final sub = ws.listen(
    (m) {
      if (m is String) {
        received.add(m.length > 40 ? '${m.substring(0, 40)}...' : m);
        if (m == text) gotText = true;
      } else if (m is List<int>) {
        received.add('<${m.length} bytes>');
        if (listEquals(m, binary)) gotBinary = true;
      }
      if (gotText && gotBinary && !both.isCompleted) both.complete();
    },
    onError: (Object e) => both.isCompleted ? null : both.completeError(e),
    onDone: () => both.isCompleted ? null : both.completeError('closed early (${ws.closeCode})'),
  );
  ws.add(text);
  ws.add(binary);
  try {
    await both.future.timeout(const Duration(seconds: 15));
  } finally {
    await ws.close(WebSocketStatus.normalClosure, 'demo done');
    await sub.cancel();
  }
  return (101, {'echoedText': gotText, 'echoedBinary': gotBinary, 'messages': received});
}

/// Server-Sent Events (package:http streaming): read until three `time` events (or five events of any name), then
/// hang up.
Future<Outcome> sseEvents() async {
  final client = http.Client();
  try {
    final req = http.Request('GET', Uri.parse(sseUrl))..headers['accept'] = 'text/event-stream';
    final res = await client.send(req).timeout(const Duration(seconds: 20));
    final events = <String>[];
    var times = 0;
    await for (final line in res.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .timeout(const Duration(seconds: 15))) {
      if (!line.startsWith('event:')) continue;
      final name = line.substring(6).trim();
      events.add(name);
      if ((name == 'time' && ++times == 3) || events.length >= 5) break;
    }
    return (res.statusCode, {'contentType': res.headers['content-type'], 'events': events});
  } finally {
    client.close();
  }
}

/// GraphQL POST with an operationName and variables.
Future<Outcome> graphqlCountry(http.Client client) async {
  final r = await client.post(
    Uri.parse(graphqlUrl),
    headers: {'content-type': 'application/json'},
    body: jsonEncode({
      'operationName': 'CountryByCode',
      'query': r'query CountryByCode($code: ID!) { country(code: $code) { name capital currency } }',
      'variables': {'code': 'EG'},
    }),
  );
  return (r.statusCode, r.body);
}

// Runs in the background isolate: a fresh isolate has its own statics, so HttpOverrides.global set
// by the main isolate is not there.
Future<Outcome> _todoInIsolate(int id) async {
  final r = await http.get(Uri.parse('https://jsonplaceholder.typicode.com/todos/$id'));
  final m = jsonDecode(r.body) as Map<String, dynamic>;
  return (r.statusCode, {'overridesInIsolate': HttpOverrides.current != null, 'id': m['id'], 'title': m['title']});
}

/// HTTP from `Isolate.run` (named isolate "demo_worker").
Future<Outcome> isolateTodo() => Isolate.run(() => _todoInIsolate(2), debugName: 'demo_worker');

/// HTTP from Flutter's `compute` (isolate named after `debugLabel`).
Future<Outcome> computeTodo() => compute(_todoInIsolate, 3, debugLabel: 'demo_compute');

/// --dart-define=NATIVE_HTTP=true : also request through the platform's HTTP stack (cupertino_http /
/// ok_http). Off by default: these never go through the proxy (read-only in Flutter Intercept).
const nativeHttp = bool.fromEnvironment('NATIVE_HTTP');

Future<Outcome> nativeGet() async {
  final client = nativeHttpClient();
  if (client == null) return (-1, 'no native client on this platform');
  try {
    final r = await client.get(Uri.parse('https://jsonplaceholder.typicode.com/posts/1'),
        headers: {'x-demo-client': nativeClientName});
    return (r.statusCode, r.body);
  } finally {
    client.close();
  }
}

Future<Outcome> nativePost() async {
  final client = nativeHttpClient();
  if (client == null) return (-1, 'no native client on this platform');
  try {
    final r = await client.post(Uri.parse('https://jsonplaceholder.typicode.com/posts'),
        headers: {'content-type': 'application/json; charset=utf-8', 'x-demo-client': nativeClientName},
        body: jsonEncode({'title': 'native', 'body': 'from $nativeClientName', 'userId': 1}));
    return (r.statusCode, r.body);
  } finally {
    client.close();
  }
}
