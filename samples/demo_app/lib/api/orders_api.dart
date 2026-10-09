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
}
