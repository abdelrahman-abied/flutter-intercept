// This is a generated file - do not edit.
//
// Generated from shop.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names

import 'dart:async' as $async;
import 'dart:core' as $core;

import 'package:grpc/service_api.dart' as $grpc;
import 'package:protobuf/protobuf.dart' as $pb;

import 'common.pb.dart' as $2;
import 'google/protobuf/empty.pb.dart' as $1;
import 'shop.pb.dart' as $0;

export 'shop.pb.dart';

@$pb.GrpcServiceName('fi.shop.v1.ShopService')
class ShopServiceClient extends $grpc.Client {
  /// The hostname for this service.
  static const $core.String defaultHost = '';

  /// OAuth scopes needed for the client.
  static const $core.List<$core.String> oauthScopes = [
    '',
  ];

  ShopServiceClient(super.channel, {super.options, super.interceptors});

  $grpc.ResponseFuture<$0.Order> getOrder(
    $0.GetOrderRequest request, {
    $grpc.CallOptions? options,
  }) {
    return $createUnaryCall(_$getOrder, request, options: options);
  }

  $grpc.ResponseStream<$0.Order> watchOrders(
    $0.GetOrderRequest request, {
    $grpc.CallOptions? options,
  }) {
    return $createStreamingCall(
        _$watchOrders, $async.Stream.fromIterable([request]),
        options: options);
  }

  $grpc.ResponseFuture<$0.Order> uploadLines(
    $async.Stream<$0.Order_Line> request, {
    $grpc.CallOptions? options,
  }) {
    return $createStreamingCall(_$uploadLines, request, options: options)
        .single;
  }

  $grpc.ResponseStream<$0.Scalars> chat(
    $async.Stream<$0.Scalars> request, {
    $grpc.CallOptions? options,
  }) {
    return $createStreamingCall(_$chat, request, options: options);
  }

  $grpc.ResponseFuture<$1.Empty> ping(
    $1.Empty request, {
    $grpc.CallOptions? options,
  }) {
    return $createUnaryCall(_$ping, request, options: options);
  }

  $grpc.ResponseFuture<$2.Money> nested(
    $0.Outer request, {
    $grpc.CallOptions? options,
  }) {
    return $createUnaryCall(_$nested, request, options: options);
  }

  // method descriptors

  static final _$getOrder = $grpc.ClientMethod<$0.GetOrderRequest, $0.Order>(
      '/fi.shop.v1.ShopService/GetOrder',
      ($0.GetOrderRequest value) => value.writeToBuffer(),
      $0.Order.fromBuffer);
  static final _$watchOrders = $grpc.ClientMethod<$0.GetOrderRequest, $0.Order>(
      '/fi.shop.v1.ShopService/WatchOrders',
      ($0.GetOrderRequest value) => value.writeToBuffer(),
      $0.Order.fromBuffer);
  static final _$uploadLines = $grpc.ClientMethod<$0.Order_Line, $0.Order>(
      '/fi.shop.v1.ShopService/UploadLines',
      ($0.Order_Line value) => value.writeToBuffer(),
      $0.Order.fromBuffer);
  static final _$chat = $grpc.ClientMethod<$0.Scalars, $0.Scalars>(
      '/fi.shop.v1.ShopService/Chat',
      ($0.Scalars value) => value.writeToBuffer(),
      $0.Scalars.fromBuffer);
  static final _$ping = $grpc.ClientMethod<$1.Empty, $1.Empty>(
      '/fi.shop.v1.ShopService/Ping',
      ($1.Empty value) => value.writeToBuffer(),
      $1.Empty.fromBuffer);
  static final _$nested = $grpc.ClientMethod<$0.Outer, $2.Money>(
      '/fi.shop.v1.ShopService/Nested',
      ($0.Outer value) => value.writeToBuffer(),
      $2.Money.fromBuffer);
}

@$pb.GrpcServiceName('fi.shop.v1.ShopService')
abstract class ShopServiceBase extends $grpc.Service {
  $core.String get $name => 'fi.shop.v1.ShopService';

  ShopServiceBase() {
    $addMethod($grpc.ServiceMethod<$0.GetOrderRequest, $0.Order>(
        'GetOrder',
        getOrder_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.GetOrderRequest.fromBuffer(value),
        ($0.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.GetOrderRequest, $0.Order>(
        'WatchOrders',
        watchOrders_Pre,
        false,
        true,
        ($core.List<$core.int> value) => $0.GetOrderRequest.fromBuffer(value),
        ($0.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.Order_Line, $0.Order>(
        'UploadLines',
        uploadLines,
        true,
        false,
        ($core.List<$core.int> value) => $0.Order_Line.fromBuffer(value),
        ($0.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.Scalars, $0.Scalars>(
        'Chat',
        chat,
        true,
        true,
        ($core.List<$core.int> value) => $0.Scalars.fromBuffer(value),
        ($0.Scalars value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$1.Empty, $1.Empty>(
        'Ping',
        ping_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $1.Empty.fromBuffer(value),
        ($1.Empty value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$0.Outer, $2.Money>(
        'Nested',
        nested_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.Outer.fromBuffer(value),
        ($2.Money value) => value.writeToBuffer()));
  }

  $async.Future<$0.Order> getOrder_Pre($grpc.ServiceCall $call,
      $async.Future<$0.GetOrderRequest> $request) async {
    return getOrder($call, await $request);
  }

  $async.Future<$0.Order> getOrder(
      $grpc.ServiceCall call, $0.GetOrderRequest request);

  $async.Stream<$0.Order> watchOrders_Pre($grpc.ServiceCall $call,
      $async.Future<$0.GetOrderRequest> $request) async* {
    yield* watchOrders($call, await $request);
  }

  $async.Stream<$0.Order> watchOrders(
      $grpc.ServiceCall call, $0.GetOrderRequest request);

  $async.Future<$0.Order> uploadLines(
      $grpc.ServiceCall call, $async.Stream<$0.Order_Line> request);

  $async.Stream<$0.Scalars> chat(
      $grpc.ServiceCall call, $async.Stream<$0.Scalars> request);

  $async.Future<$1.Empty> ping_Pre(
      $grpc.ServiceCall $call, $async.Future<$1.Empty> $request) async {
    return ping($call, await $request);
  }

  $async.Future<$1.Empty> ping($grpc.ServiceCall call, $1.Empty request);

  $async.Future<$2.Money> nested_Pre(
      $grpc.ServiceCall $call, $async.Future<$0.Outer> $request) async {
    return nested($call, await $request);
  }

  $async.Future<$2.Money> nested($grpc.ServiceCall call, $0.Outer request);
}
