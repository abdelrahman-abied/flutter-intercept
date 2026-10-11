//
//  Generated code. Do not modify.
//  source: legacy.proto
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

import 'legacy.pb.dart' as $0;

export 'legacy.pb.dart';

@$pb.GrpcServiceName('fi.legacy.LegacyService')
class LegacyServiceClient extends $grpc.Client {
  static final _$process = $grpc.ClientMethod<$0.Legacy, $0.Legacy>(
      '/fi.legacy.LegacyService/Process',
      ($0.Legacy value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $0.Legacy.fromBuffer(value));

  LegacyServiceClient($grpc.ClientChannel channel,
      {$grpc.CallOptions? options,
      $core.Iterable<$grpc.ClientInterceptor>? interceptors})
      : super(channel, options: options,
        interceptors: interceptors);

  $grpc.ResponseFuture<$0.Legacy> process($0.Legacy request, {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$process, request, options: options);
  }
}

@$pb.GrpcServiceName('fi.legacy.LegacyService')
abstract class LegacyServiceBase extends $grpc.Service {
  $core.String get $name => 'fi.legacy.LegacyService';

  LegacyServiceBase() {
    $addMethod($grpc.ServiceMethod<$0.Legacy, $0.Legacy>(
        'Process',
        process_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.Legacy.fromBuffer(value),
        ($0.Legacy value) => value.writeToBuffer()));
  }

  $async.Future<$0.Legacy> process_Pre($grpc.ServiceCall call, $async.Future<$0.Legacy> request) async {
    return process(call, await request);
  }

  $async.Future<$0.Legacy> process($grpc.ServiceCall call, $0.Legacy request);
}
