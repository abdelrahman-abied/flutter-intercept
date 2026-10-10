// ignore_for_file: avoid_print

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const _jp = 'https://jsonplaceholder.typicode.com';
// A real JSON API that answers without Access-Control-Allow-Origin (MediaWiki needs `origin=*` for CORS).
const _noCors = 'https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json';

int _run = 0;

void main() {
  final results = ValueNotifier<List<String>>([]);
  runApp(WebDemoApp(results: results));
  runBatch(results);
}

String _compact(Object? body) {
  final text = (body is String ? body : jsonEncode(body)).replaceAll(RegExp(r'\s+'), ' ');
  return text.length > 160 ? text.substring(0, 160) : text;
}

Future<void> runBatch(ValueNotifier<List<String>> results) async {
  _run++;
  print('WEB_START run=$_run');
  final dio = Dio();
  final client = http.Client(); // BrowserClient on the web
  var ok = 0, err = 0;

  Future<void> step(String label, Future<(int, Object?)> Function() call) async {
    final sw = Stopwatch()..start();
    String line;
    try {
      final (status, body) = await call();
      ok++;
      line = 'WEB_RESULT $label $status ms=${sw.elapsedMilliseconds} ${_compact(body)}';
    } on DioException catch (e) {
      err++;
      final status = e.response?.statusCode;
      line = 'WEB_RESULT $label ${status ?? 'ERR'} ms=${sw.elapsedMilliseconds} ${_compact('${e.type.name}: ${e.message ?? e.error}')}';
    } catch (e) {
      err++;
      line = 'WEB_RESULT $label ERR ms=${sw.elapsedMilliseconds} ${_compact(e.toString())}';
    }
    print(line);
    results.value = [...results.value, line];
  }

  await step('http_todo', () async {
    final r = await client.get(Uri.parse('$_jp/todos/1'));
    return (r.statusCode, r.body);
  });
  await step('dio_user', () async {
    final r = await dio.get<Object?>('$_jp/users/1');
    return (r.statusCode ?? 0, r.data);
  });
  await step('dio_post', () async {
    final r = await dio.post<Object?>('$_jp/posts', data: {'title': 'from flutter web', 'body': 'hello', 'userId': 1});
    return (r.statusCode ?? 0, r.data);
  });
  await step('http_post', () async {
    final r = await client.post(
      Uri.parse('$_jp/todos'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'title': 'web todo', 'completed': false, 'userId': 1}),
    );
    return (r.statusCode, r.body);
  });
  await step('dio_profile', () async {
    final r = await dio.get<Object?>('$_jp/users/2', options: Options(headers: {'x-demo-client': 'web_app'}));
    return (r.statusCode ?? 0, r.data);
  });
  await step('cors_blocked', () async {
    final r = await client.get(Uri.parse(_noCors));
    return (r.statusCode, r.body);
  });

  client.close();
  print('WEB_BATCH done ok=$ok err=$err');
}

class WebDemoApp extends StatelessWidget {
  const WebDemoApp({super.key, required this.results});

  final ValueNotifier<List<String>> results;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Intercept web sample',
      home: Scaffold(
        appBar: AppBar(title: const Text('Flutter Intercept web sample')),
        body: ValueListenableBuilder<List<String>>(
          valueListenable: results,
          builder: (context, lines, _) => ListView(
            padding: const EdgeInsets.all(12),
            children: [for (final l in lines) SelectableText(l, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))],
          ),
        ),
      ),
    );
  }
}
