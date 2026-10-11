// This is a generated file - do not edit.
//
// Generated from nopkg.proto.

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

import 'nopkg.pb.dart' as $0;

export 'nopkg.pb.dart';

@$pb.GrpcServiceName('NoPkg')
class NoPkgClient extends $grpc.Client {
  /// The hostname for this service.
  static const $core.String defaultHost = '';

  /// OAuth scopes needed for the client.
  static const $core.List<$core.String> oauthScopes = [
    '',
  ];

  NoPkgClient(super.channel, {super.options, super.interceptors});

  $grpc.ResponseFuture<$0.Bare> echo(
    $0.Bare request, {
    $grpc.CallOptions? options,
  }) {
    return $createUnaryCall(_$echo, request, options: options);
  }

  // method descriptors

  static final _$echo = $grpc.ClientMethod<$0.Bare, $0.Bare>('/NoPkg/Echo',
      ($0.Bare value) => value.writeToBuffer(), $0.Bare.fromBuffer);
}

@$pb.GrpcServiceName('NoPkg')
abstract class NoPkgServiceBase extends $grpc.Service {
  $core.String get $name => 'NoPkg';

  NoPkgServiceBase() {
    $addMethod($grpc.ServiceMethod<$0.Bare, $0.Bare>(
        'Echo',
        echo_Pre,
        false,
        false,
        ($core.List<$core.int> value) => $0.Bare.fromBuffer(value),
        ($0.Bare value) => value.writeToBuffer()));
  }

  $async.Future<$0.Bare> echo_Pre(
      $grpc.ServiceCall $call, $async.Future<$0.Bare> $request) async {
    return echo($call, await $request);
  }

  $async.Future<$0.Bare> echo($grpc.ServiceCall call, $0.Bare request);
}
