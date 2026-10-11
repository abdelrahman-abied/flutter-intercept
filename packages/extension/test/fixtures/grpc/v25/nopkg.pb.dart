// This is a generated file - do not edit.
//
// Generated from nopkg.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports

import 'dart:core' as $core;

import 'package:protobuf/protobuf.dart' as $pb;

export 'package:protobuf/protobuf.dart' show GeneratedMessageGenericExtensions;

class Bare extends $pb.GeneratedMessage {
  factory Bare({
    $core.String? a,
    $core.Iterable<Bare>? children,
  }) {
    final result = Bare._();
    if (a != null) result.a = a;
    if (children != null) result.children.addAll(children);
    return result;
  }

  Bare._();

  factory Bare.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Bare()..mergeFromBuffer(data, registry);
  factory Bare.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Bare()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Bare',
      createEmptyInstance: Bare.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'a')
    ..pPM<Bare>(2, _omitFieldNames ? '' : 'children',
        subBuilder: Bare.$_createMessage)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Bare clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Bare copyWith(void Function(Bare) updates) =>
      super.copyWith((message) => updates(message as Bare)) as Bare;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use Bare() / Bare.new instead')
  static Bare create() => Bare._();
  static $pb.GeneratedMessage $_createMessage() => Bare._();
  @$core.override
  Bare createEmptyInstance() => Bare._();
  @$core.pragma('dart2js:noInline')
  static Bare getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Bare>(Bare.$_createMessage);
  static Bare? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get a => $_getSZ(0);
  @$pb.TagNumber(1)
  set a($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasA() => $_has(0);
  @$pb.TagNumber(1)
  void clearA() => $_clearField(1);

  @$pb.TagNumber(2)
  $pb.PbList<Bare> get children => $_getList(1);
}

const $core.bool _omitFieldNames =
    $core.bool.fromEnvironment('protobuf.omit_field_names');
const $core.bool _omitMessageNames =
    $core.bool.fromEnvironment('protobuf.omit_message_names');
