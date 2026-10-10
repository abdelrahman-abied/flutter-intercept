// GENERATED CODE - DO NOT MODIFY BY HAND
// dart format width=80

part of 'chop.dart';

// **************************************************************************
// ChopperGenerator
// **************************************************************************

// coverage:ignore-file
// ignore_for_file: type=lint
final class _$ItemService extends ItemService {
  _$ItemService([ChopperClient? client]) {
    if (client == null) return;
    this.client = client;
  }

  @override
  final Type definitionType = ItemService;

  @override
  Future<Response<Item>> getItem(String id) {
    final Uri $url = Uri.parse('/items/${id}');
    final Request $request = Request('GET', $url, client.baseUrl);
    return client.send<Item, Item>($request);
  }

  @override
  Future<Response<List<Item>>> list({int page = 1}) {
    final Uri $url = Uri.parse('/items');
    final Map<String, dynamic> $params = <String, dynamic>{'page': page};
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
    );
    return client.send<List<Item>, Item>($request);
  }

  @override
  Future<Response<Item>> create(Map<String, dynamic> body) {
    final Uri $url = Uri.parse('/items/');
    final $body = body;
    final Request $request = Request('POST', $url, client.baseUrl, body: $body);
    return client.send<Item, Item>($request);
  }
}
