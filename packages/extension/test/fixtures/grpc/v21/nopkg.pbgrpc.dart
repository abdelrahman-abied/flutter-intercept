//
//  Generated code. Do not modify.
//  source: nopkg.proto
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

import 'nopkg.pb.dart' as $1;

export 'nopkg.pb.dart';

@$pb.GrpcServiceName('NoPkg')
class NoPkgClient extends $grpc.Client {
  static final _$echo = $grpc.ClientMethod<$1.Bare, $1.Bare>(
      '/NoPkg/Echo',
      ($1.Bare value) => value.writeToBuffer(),
      ($core.List<$core.int> value) => $1.Bare.fromBuffer(value));

  NoPkgClient($grpc.ClientChannel channel,
      {$grpc.CallOptions? options,
      $core.Iterable<$grpc.ClientInterceptor>? interceptors})
      : super(channel, options: options,
        interceptors: interceptors);

  $grpc.ResponseFuture<$1.Bare> echo($1.Bare request, {$grpc.CallOptions? options}) {
    return $createUnaryCall(_$echo, request, options: options);
  }
}

@$pb.GrpcServiceName('NoPkg')
abstract class NoPkgServiceBase extends $grpc.Service {
  $core.String get $name => 'NoPkg';

  NoPkgServiceBase() {
    $addMethod($grpc.ServiceMethod<$1.Bare, $1.Bare>(
        'Echo',
        echo_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $1.Bare.fromBuffer(value),
        ($1.Bare value) => value.writeToBuffer()));
  }

  $async.Future<$1.Bare> echo_Pre($grpc.ServiceCall call, $async.Future<$1.Bare> request) async {
    return echo(call, await request);
  }

  $async.Future<$1.Bare> echo($grpc.ServiceCall call, $1.Bare request);
}
