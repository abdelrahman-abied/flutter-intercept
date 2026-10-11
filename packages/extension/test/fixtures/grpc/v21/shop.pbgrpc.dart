//
//  Generated code. Do not modify.
//  source: shop.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:async' as $async;
import 'dart:core' as $core;

import 'package:grpc/service_api.dart' as $grpc;
import 'package:protobuf/protobuf.dart' as $pb;

import 'common.pb.dart' as $4;
import 'google/protobuf/empty.pb.dart' as $3;
import 'shop.pb.dart' as $2;

export 'shop.pb.dart';

@$pb.GrpcServiceName('fi.shop.v1.ShopService')
class ShopServiceClient extends $grpc.Client {
  static final _$getOrder = $grpc.ClientMethod<$2.GetOrderRequest, $2.Order>(
      '/fi.shop.v1.ShopService/GetOrder',
      ($2.GetOrderRequest value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $2.Order.fromBuffer(value));
  static final _$watchOrders = $grpc.ClientMethod<$2.GetOrderRequest, $2.Order>(
      '/fi.shop.v1.ShopService/WatchOrders',
      ($2.GetOrderRequest value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $2.Order.fromBuffer(value));
  static final _$uploadLines = $grpc.ClientMethod<$2.Order_Line, $2.Order>(
      '/fi.shop.v1.ShopService/UploadLines',
      ($2.Order_Line value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $2.Order.fromBuffer(value));
  static final _$chat = $grpc.ClientMethod<$2.Scalars, $2.Scalars>(
      '/fi.shop.v1.ShopService/Chat',
      ($2.Scalars value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $2.Scalars.fromBuffer(value));
  static final _$ping = $grpc.ClientMethod<$3.Empty, $3.Empty>(
      '/fi.shop.v1.ShopService/Ping',
      ($3.Empty value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $3.Empty.fromBuffer(value));
  static final _$nested = $grpc.ClientMethod<$2.Outer, $4.Money>(
      '/fi.shop.v1.ShopService/Nested',
      ($2.Outer value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $4.Money.fromBuffer(value));

  ShopServiceClient($grpc.ClientChannel channel,
      {$grpc.CallOptions? options,
      $core.Iterable<$grpc.ClientInterceptor>? interceptors})
      : super(channel, options: options,
        interceptors: interceptors);

  $grpc.ResponseFuture<$2.Order> getOrder($2.GetOrderRequest request, {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$getOrder, request, options: options);
  }

  $grpc.ResponseStream<$2.Order> watchOrders($2.GetOrderRequest request, {$grpc.CallOptions? options}) {
    return $createStreamingCall(_$watchOrders, $async.Stream.fromIterable([request]), options: options);
  }

  $grpc.ResponseFuture<$2.Order> uploadLines($async.Stream<$2.Order_Line> request, {$grpc.CallOptions? options}) {
    return $createStreamingCall(_$uploadLines, request, options: options).single;
  }

  $grpc.ResponseStream<$2.Scalars> chat($async.Stream<$2.Scalars> request, {$grpc.CallOptions? options}) {
    return $createStreamingCall(_$chat, request, options: options);
  }

  $grpc.ResponseFuture<$3.Empty> ping($3.Empty request, {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$ping, request, options: options);
  }

  $grpc.ResponseFuture<$4.Money> nested($2.Outer request, {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$nested, request, options: options);
  }
}

@$pb.GrpcServiceName('fi.shop.v1.ShopService')
abstract class ShopServiceBase extends $grpc.Service {
  $core.String get $name => 'fi.shop.v1.ShopService';

  ShopServiceBase() {
    $addMethod($grpc.ServiceMethod<$2.GetOrderRequest, $2.Order>(
        'GetOrder',
        getOrder_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $2.GetOrderRequest.fromBuffer(value),
        ($2.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$2.GetOrderRequest, $2.Order>(
        'WatchOrders',
        watchOrders_Pre,
        false,
        true,
        ($core.List<$core.int> value) => $2.GetOrderRequest.fromBuffer(value),
        ($2.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$2.Order_Line, $2.Order>(
        'UploadLines',
        uploadLines,
        true,
        false,
        ($core.List<$core.int> value) => $2.Order_Line.fromBuffer(value),
        ($2.Order value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$2.Scalars, $2.Scalars>(
        'Chat',
        chat,
        true,
        true,
        ($core.List<$core.int> value) => $2.Scalars.fromBuffer(value),
        ($2.Scalars value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$3.Empty, $3.Empty>(
        'Ping',
        ping_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $3.Empty.fromBuffer(value),
        ($3.Empty value) => value.writeToBuffer()));
    $addMethod($grpc.ServiceMethod<$2.Outer, $4.Money>(
        'Nested',
        nested_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $2.Outer.fromBuffer(value),
        ($4.Money value) => value.writeToBuffer()));
  }

  $async.Future<$2.Order> getOrder_Pre($grpc.ServiceCall call, $async.Future<$2.GetOrderRequest> request) async {
    return getOrder(call, await request);
  }

  $async.Stream<$2.Order> watchOrders_Pre($grpc.ServiceCall call, $async.Future<$2.GetOrderRequest> request) async* {
    yield* watchOrders(call, await request);
  }

  $async.Future<$3.Empty> ping_Pre($grpc.ServiceCall call, $async.Future<$3.Empty> request) async {
    return ping(call, await request);
  }

  $async.Future<$4.Money> nested_Pre($grpc.ServiceCall call, $async.Future<$2.Outer> request) async {
    return nested(call, await request);
  }

  $async.Future<$2.Order> getOrder($grpc.ServiceCall call, $2.GetOrderRequest request);
  $async.Stream<$2.Order> watchOrders($grpc.ServiceCall call, $2.GetOrderRequest request);
  $async.Future<$2.Order> uploadLines($grpc.ServiceCall call, $async.Stream<$2.Order_Line> request);
  $async.Stream<$2.Scalars> chat($grpc.ServiceCall call, $async.Stream<$2.Scalars> request);
  $async.Future<$3.Empty> ping($grpc.ServiceCall call, $3.Empty request);
  $async.Future<$4.Money> nested($grpc.ServiceCall call, $2.Outer request);
}
