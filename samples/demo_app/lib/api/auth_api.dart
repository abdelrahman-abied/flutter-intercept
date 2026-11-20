// Auth API: sign-in and token-refresh flow for light auth simulation (CONTRACTS §24.1).
// Plain app code, no interception code.
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Access and refresh tokens read from a login or refresh JSON response (CONTRACTS §24.1).
/// [toString] never includes the token values.
class AuthTokens {
  const AuthTokens({this.accessToken, this.refreshToken});

  final String? accessToken;
  final String? refreshToken;

  @override
  String toString() =>
      'AuthTokens(hasAccess: ${accessToken != null}, hasRefresh: ${refreshToken != null})';
}

const _accessTokenKeys = ['access_token', 'token', 'accessToken', 'jwt', 'id_token', 'idToken'];
const _refreshTokenKeys = ['refresh_token', 'refreshToken'];

String? _firstNonEmptyString(Map<Object?, Object?> map, List<String> keys) {
  for (final key in keys) {
    final value = map[key];
    if (value is String && value.isNotEmpty) return value;
  }
  return null;
}

/// Extracts `access_token` (or `token` / `jwt` / `id_token`) and `refresh_token` from a JSON response body
/// (CONTRACTS §24.1). Also checks a nested `data` object when not found at the top level. Never throws.
AuthTokens extractAuthTokens(String body) {
  if (body.isEmpty) return const AuthTokens();
  final Object? decoded;
  try {
    decoded = jsonDecode(body);
  } catch (_) {
    return const AuthTokens();
  }
  if (decoded is! Map) return const AuthTokens();

  var access = _firstNonEmptyString(decoded, _accessTokenKeys);
  var refresh = _firstNonEmptyString(decoded, _refreshTokenKeys);

  if (access == null || refresh == null) {
    final nested = decoded['data'];
    if (nested is Map) {
      access ??= _firstNonEmptyString(nested, _accessTokenKeys);
      refresh ??= _firstNonEmptyString(nested, _refreshTokenKeys);
    }
  }

  return AuthTokens(accessToken: access, refreshToken: refresh);
}

class AuthApi {
  AuthApi(this._client);
  final http.Client _client;

  static final Uri loginUri = Uri.parse('https://jsonplaceholder.typicode.com/auth/login');
  static final Uri refreshUri = Uri.parse('https://jsonplaceholder.typicode.com/auth/refresh');
  static final Uri protectedTodoUri = Uri.parse('https://jsonplaceholder.typicode.com/todos/1');

  /// `POST /auth/login` with demo credentials (CONTRACTS §24.1).
  Future<http.Response> login() => _client.post(
        loginUri,
        headers: const {'content-type': 'application/json; charset=utf-8'},
        body: jsonEncode(const {'email': 'demo@example.com', 'password': 'demo-password'}),
      );

  /// `GET /todos/1` with `Authorization: Bearer <token>` when a token is available (CONTRACTS §24.1).
  Future<http.Response> fetchProtectedTodo(String? accessToken) => _client.get(
        protectedTodoUri,
        headers: accessToken != null && accessToken.isNotEmpty
            ? {'Authorization': 'Bearer $accessToken'}
            : null,
      );

  /// `POST /auth/refresh` with `{"refresh_token": ...}` (CONTRACTS §24.1).
  Future<http.Response> refresh(String? refreshToken) => _client.post(
        refreshUri,
        headers: const {'content-type': 'application/json; charset=utf-8'},
        body: jsonEncode({'refresh_token': refreshToken ?? ''}),
      );
}

/// Runs the 4-step sign-in round (login → GET → refresh → GET) and logs one `DEMO_RESULT auth_*` line per call
/// without ever logging tokens or passwords (CONTRACTS §24.1).
Future<void> runAuthRound(AuthApi auth, {required void Function(String line) log}) async {
  var loginTokens = const AuthTokens();
  try {
    final r = await auth.login().timeout(const Duration(seconds: 20));
    log('DEMO_RESULT auth_login status=${r.statusCode}');
    loginTokens = extractAuthTokens(r.body);
  } catch (_) {
    log('DEMO_RESULT auth_login status=ERR');
  }

  try {
    final r = await auth.fetchProtectedTodo(loginTokens.accessToken).timeout(const Duration(seconds: 20));
    log('DEMO_RESULT auth_get status=${r.statusCode}');
  } catch (_) {
    log('DEMO_RESULT auth_get status=ERR');
  }

  var refreshedTokens = const AuthTokens();
  try {
    final r = await auth.refresh(loginTokens.refreshToken).timeout(const Duration(seconds: 20));
    log('DEMO_RESULT auth_refresh status=${r.statusCode}');
    refreshedTokens = extractAuthTokens(r.body);
  } catch (_) {
    log('DEMO_RESULT auth_refresh status=ERR');
  }

  try {
    final r = await auth.fetchProtectedTodo(refreshedTokens.accessToken).timeout(const Duration(seconds: 20));
    log('DEMO_RESULT auth_get2 status=${r.statusCode}');
  } catch (_) {
    log('DEMO_RESULT auth_get2 status=ERR');
  }
}
