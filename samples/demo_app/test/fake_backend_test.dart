import 'dart:convert';

import 'package:demo_app/api/auth_api.dart';
import 'package:demo_app/api/orders_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('parseListCount (CONTRACTS §22.5)', () {
    test('returns length of a top-level JSON array', () {
      expect(parseListCount('[]'), 0);
      expect(parseListCount('[{"id":1},{"id":2},{"id":3}]'), 3);
    });

    test('returns length of a data array inside a JSON object', () {
      expect(parseListCount('{"data":[]}'), 0);
      expect(parseListCount('{"data":[{"id":1},{"id":2}],"total":2}'), 2);
    });

    test('returns -1 for non-JSON and non-list JSON bodies', () {
      expect(parseListCount(''), -1);
      expect(parseListCount('not json'), -1);
      expect(parseListCount('<html>error</html>'), -1);
      expect(parseListCount('{"error":"not_found"}'), -1);
      expect(parseListCount('{"data":"not a list"}'), -1);
      expect(parseListCount('{"data":null}'), -1);
      expect(parseListCount('null'), -1);
      expect(parseListCount('42'), -1);
      expect(parseListCount('"hello"'), -1);
      expect(parseListCount('true'), -1);
    });
  });

  group('runTodosList (CONTRACTS §22.5)', () {
    test('logs status and count for JSON array response', () async {
      final client = MockClient((req) async {
        expect(req.method, 'GET');
        expect(req.url.toString(), 'https://jsonplaceholder.typicode.com/todos');
        return http.Response('[{"id":1},{"id":2}]', 200);
      });
      final line = await runTodosList(OrdersApi(client));
      expect(line, 'DEMO_RESULT todos_list status=200 count=2');
    });

    test('logs status and count for wrapped data array response', () async {
      final client = MockClient((_) async => http.Response('{"data":[{"id":1}]}', 200));
      final line = await runTodosList(OrdersApi(client));
      expect(line, 'DEMO_RESULT todos_list status=200 count=1');
    });

    test('logs count=-1 for non-JSON response', () async {
      final client = MockClient((_) async => http.Response('Bad Gateway', 502));
      final line = await runTodosList(OrdersApi(client));
      expect(line, 'DEMO_RESULT todos_list status=502 count=-1');
    });

    test('logs status=ERR count=-1 when the request throws', () async {
      final client = MockClient((_) async => throw Exception('network down'));
      final line = await runTodosList(OrdersApi(client));
      expect(line, 'DEMO_RESULT todos_list status=ERR count=-1');
    });
  });

  group('extractAuthTokens (CONTRACTS §24.1)', () {
    test('extracts access_token and refresh_token', () {
      final tokens = extractAuthTokens('{"access_token":"tok-1","refresh_token":"ref-1"}');
      expect(tokens.accessToken, 'tok-1');
      expect(tokens.refreshToken, 'ref-1');
    });

    test('falls back to token when access_token is absent', () {
      final tokens = extractAuthTokens('{"token":"tok-2","refresh_token":"ref-2"}');
      expect(tokens.accessToken, 'tok-2');
      expect(tokens.refreshToken, 'ref-2');
    });

    test('prefers access_token over token when both are present', () {
      final tokens = extractAuthTokens('{"token":"fallback","access_token":"primary","refresh_token":"ref-3"}');
      expect(tokens.accessToken, 'primary');
      expect(tokens.refreshToken, 'ref-3');
    });

    test('supports jwt, id_token, camelCase, and nested data objects', () {
      expect(extractAuthTokens('{"jwt":"j.w.t"}').accessToken, 'j.w.t');
      expect(extractAuthTokens('{"id_token":"id-1"}').accessToken, 'id-1');
      final camel = extractAuthTokens('{"accessToken":"c-tok","refreshToken":"c-ref"}');
      expect(camel.accessToken, 'c-tok');
      expect(camel.refreshToken, 'c-ref');
      final nested = extractAuthTokens('{"data":{"access_token":"n-tok","refresh_token":"n-ref"}}');
      expect(nested.accessToken, 'n-tok');
      expect(nested.refreshToken, 'n-ref');
    });

    test('ignores empty strings, non-strings, and invalid JSON without throwing', () {
      expect(extractAuthTokens('').accessToken, isNull);
      expect(extractAuthTokens('not json').accessToken, isNull);
      expect(extractAuthTokens('[]').accessToken, isNull);
      expect(extractAuthTokens('null').accessToken, isNull);
      expect(extractAuthTokens('{"access_token":"","token":"fallback","refresh_token":123}').accessToken, 'fallback');
      expect(extractAuthTokens('{"access_token":"","refresh_token":123}').refreshToken, isNull);
    });

    test('toString never exposes token values', () {
      const tokens = AuthTokens(accessToken: 'secret-access', refreshToken: 'secret-refresh');
      final text = tokens.toString();
      expect(text, isNot(contains('secret-access')));
      expect(text, isNot(contains('secret-refresh')));
    });
  });

  group('runAuthRound (CONTRACTS §24.1)', () {
    test('sends login, GET with token, refresh, GET with new token and never logs secrets', () async {
      final seen = <(String, String, Map<String, String>, String)>[];
      final client = MockClient((req) async {
        seen.add((req.method, req.url.toString(), Map<String, String>.from(req.headers), req.body));
        if (req.url.path == '/auth/login') {
          return http.Response('{"access_token":"fi.tok1","refresh_token":"fi.ref1"}', 200);
        }
        if (req.url.path == '/auth/refresh') {
          return http.Response('{"token":"fi.tok2","refresh_token":"fi.ref2"}', 200);
        }
        if (req.url.path == '/todos/1') {
          return http.Response('{"id":1}', 200);
        }
        return http.Response('not found', 404);
      });

      final lines = <String>[];
      await runAuthRound(AuthApi(client), log: lines.add);

      expect(lines, [
        'DEMO_RESULT auth_login status=200',
        'DEMO_RESULT auth_get status=200',
        'DEMO_RESULT auth_refresh status=200',
        'DEMO_RESULT auth_get2 status=200',
      ]);

      expect(seen.length, 4);
      expect(seen[0].$1, 'POST');
      expect(seen[0].$2, 'https://jsonplaceholder.typicode.com/auth/login');
      expect(jsonDecode(seen[0].$4), {'email': 'demo@example.com', 'password': 'demo-password'});

      expect(seen[1].$1, 'GET');
      expect(seen[1].$2, 'https://jsonplaceholder.typicode.com/todos/1');
      expect(seen[1].$3['Authorization'], 'Bearer fi.tok1');

      expect(seen[2].$1, 'POST');
      expect(seen[2].$2, 'https://jsonplaceholder.typicode.com/auth/refresh');
      expect(jsonDecode(seen[2].$4), {'refresh_token': 'fi.ref1'});

      expect(seen[3].$1, 'GET');
      expect(seen[3].$2, 'https://jsonplaceholder.typicode.com/todos/1');
      expect(seen[3].$3['Authorization'], 'Bearer fi.tok2');

      final joined = lines.join('\n');
      for (final secret in ['fi.tok1', 'fi.tok2', 'fi.ref1', 'fi.ref2', 'demo-password']) {
        expect(joined, isNot(contains(secret)));
      }
    });

    test('omits Authorization header when login or refresh yields no token and logs ERR on throw', () async {
      final authHeaders = <String?>[];
      final client = MockClient((req) async {
        if (req.url.path == '/auth/login') return http.Response('{"error":"bad"}', 401);
        if (req.url.path == '/auth/refresh') throw Exception('connection reset');
        authHeaders.add(req.headers['Authorization']);
        return http.Response('{"error":"unauthorized"}', 401);
      });

      final lines = <String>[];
      await runAuthRound(AuthApi(client), log: lines.add);

      expect(lines, [
        'DEMO_RESULT auth_login status=401',
        'DEMO_RESULT auth_get status=401',
        'DEMO_RESULT auth_refresh status=ERR',
        'DEMO_RESULT auth_get2 status=401',
      ]);
      expect(authHeaders, [null, null]);
    });
  });
}
