// Orders API: package:http with a long-lived Client. Plain app code, no interception code.
import 'dart:convert';

import 'package:http/http.dart' as http;

class OrdersApi {
  OrdersApi(this._client);
  final http.Client _client;
  int _orders = 0;

  /// POST https://jsonplaceholder.typicode.com/todos with a JSON body: a request worth resending
  /// (the server answers 201 with the created item, so a resend is easy to tell apart).
  Future<http.Response> createOrder({required String item, int quantity = 1}) {
    _orders++;
    return _client.post(
      Uri.parse('https://jsonplaceholder.typicode.com/todos'),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'idempotency-key': 'demo-order-$_orders',
      },
      body: jsonEncode({'title': 'order: $quantity x $item', 'completed': false, 'userId': 1}),
    );
  }

  /// GET https://jsonplaceholder.typicode.com/todos: lists all todos (CONTRACTS §22.5).
  Future<http.Response> listTodos() =>
      _client.get(Uri.parse('https://jsonplaceholder.typicode.com/todos'));
}

/// Returns the item count of a JSON list response: the array's length, or the length of a top-level `data` array
/// when the response is a JSON object, or `-1` when the body is not JSON or has no array (CONTRACTS §22.5).
int parseListCount(String body) {
  if (body.isEmpty) return -1;
  final Object? decoded;
  try {
    decoded = jsonDecode(body);
  } catch (_) {
    return -1;
  }
  if (decoded is List) return decoded.length;
  if (decoded is Map) {
    final data = decoded['data'];
    if (data is List) return data.length;
  }
  return -1;
}

/// Calls `GET /todos` and formats the `DEMO_RESULT todos_list` log line (CONTRACTS §22.5).
Future<String> runTodosList(OrdersApi orders) async {
  try {
    final r = await orders.listTodos().timeout(const Duration(seconds: 20));
    final count = parseListCount(r.body);
    return 'DEMO_RESULT todos_list status=${r.statusCode} count=$count';
  } catch (_) {
    return 'DEMO_RESULT todos_list status=ERR count=-1';
  }
}
