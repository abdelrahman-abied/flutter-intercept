// This is a generated file - do not edit.
//
// Generated from demo/orders/v1/orders.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports

import 'dart:async' as $async;
import 'dart:core' as $core;

import 'package:grpc/service_api.dart' as $grpc;
import 'package:protobuf/protobuf.dart' as $pb;

import 'orders.pb.dart' as $0;

export 'orders.pb.dart';

/// One RPC of each kind.
@$pb.GrpcServiceName('demo.orders.v1.OrderService')
class OrderServiceClient extends $grpc.Client {
  /// The hostname for this service.
  static const $core.String defaultHost = '';

  /// OAuth scopes needed for the client.
  static const $core.List<$core.String> oauthScopes = [
    '',
  ];

  OrderServiceClient(super.channel, {super.options, super.interceptors});

  /// Unary. `id: "missing"` answers NOT_FOUND.
  $grpc.ResponseFuture<$0.Order> getOrder(
    $0.GetOrderRequest request, {
    $grpc.CallOptions? options,
  }) {
    return $createUnaryCall(_$getOrder, request, options: options);
  }

  /// Server streaming: `max_events` status changes, `interval_ms` apart.
  $grpc.ResponseStream<$0.OrderEvent> watchOrders(
    $0.WatchOrdersRequest request, {
    $grpc.CallOptions? options,
  }) {
    return $createStreamingCall(
        _$watchOrders, $async.Stream.fromIterable([request]),
        options: options);
  }

  /// Client streaming: the server sums what it receives.
  $grpc.ResponseFuture<$0.UploadSummary> uploadItems(
    $async.Stream<$0.LineItem> request, {
    $grpc.CallOptions? options,
  }) {
    return $createStreamingCall(_$uploadItems, request, options: options)
        .single;
  }

  /// Bidirectional streaming: every message is answered at once.
  $grpc.ResponseStream<$0.ChatMessage> chat(
    $async.Stream<$0.ChatMessage> request, {
    $grpc.CallOptions? options,
  }) {
    return $createStreamingCall(_$chat, request, options: options);
  }

  // method descriptors

  static final _$getOrder = $grpc.ClientMethod<$0.GetOrderRequest, $0.Order>(
      '/demo.orders.v1.OrderService/GetOrder',
      ($0.GetOrderRequest value) => value.writeToBuffer(),
      $0.Order.fromBuffer);
  static final _$watchOrders =
      $grpc.ClientMethod<$0.WatchOrdersRequest, $0.OrderEvent>(
          '/demo.orders.v1.OrderService/WatchOrders',
          ($0.WatchOrdersRequest value) => value.writeToBuffer(),
          $0.OrderEvent.fromBuffer);
  static final _$uploadItems =
      $grpc.ClientMethod<$0.LineItem, $0.UploadSummary>(
          '/demo.orders.v1.OrderService/UploadItems',
          ($0.LineItem value) => value.writeToBuffer(),
          $0.UploadSummary.fromBuffer);
  static final _$chat = $grpc.ClientMethod<$0.ChatMessage, $0.ChatMessage>(
      '/demo.orders.v1.OrderService/Chat',
      ($0.ChatMessage value) => value.writeToBuffer(),
      $0.ChatMessage.fromBuffer);
}

@$pb.GrpcServiceName('demo.orders.v1.OrderService')
abstract class OrderServiceBase extends $grpc.Service {
  $core.String get $name => 'demo.orders.v1.OrderService';

  OrderServiceBase() {
    $addMethod($grpc.ServiceMethod<$0.GetOrderRequest, $0.Order>(
        'GetOrder',
        getOrder_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.GetOrderRequest.fromBuffer(value),
        ($0.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.WatchOrdersRequest, $0.OrderEvent>(
        'WatchOrders',
        watchOrders_Pre,
        false,
        true,
        ($core.List<$core.int> value) =>
            $0.WatchOrdersRequest.fromBuffer(value),
        ($0.OrderEvent value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.LineItem, $0.UploadSummary>(
        'UploadItems',
        uploadItems,
        true,
        false,
        ($core.List<$core.int> value) => $0.LineItem.fromBuffer(value),
        ($0.UploadSummary value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.ChatMessage, $0.ChatMessage>(
        'Chat',
        chat,
        true,
        true,
        ($core.List<$core.int> value) => $0.ChatMessage.fromBuffer(value),
        ($0.ChatMessage value) => value.writeToBuffer()));
  }

  $async.Future<$0.Order> getOrder_Pre($grpc.ServiceCall $call,
      $async.Future<$0.GetOrderRequest> $request) async {
    return getOrder($call, await $request);
  }

  $async.Future<$0.Order> getOrder(
      $grpc.ServiceCall call, $0.GetOrderRequest request);

  $async.Stream<$0.OrderEvent> watchOrders_Pre($grpc.ServiceCall $call,
      $async.Future<$0.WatchOrdersRequest> $request) async* {
    yield* watchOrders($call, await $request);
  }

  $async.Stream<$0.OrderEvent> watchOrders(
      $grpc.ServiceCall call, $0.WatchOrdersRequest request);

  $async.Future<$0.UploadSummary> uploadItems(
      $grpc.ServiceCall call, $async.Stream<$0.LineItem> request);

  $async.Stream<$0.ChatMessage> chat(
      $grpc.ServiceCall call, $async.Stream<$0.ChatMessage> request);
}
