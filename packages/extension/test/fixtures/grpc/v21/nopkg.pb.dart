//
//  Generated code. Do not modify.
//  source: nopkg.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:core' as $core;

import 'package:protobuf/protobuf.dart' as $pb;

class Bare extends $pb.GeneratedMessage {
  factory Bare({
    $core.String? a,
    $core.Iterable<Bare>? children,
  }) {
    final $result = create();
    if (a != null) {
      $result.a = a;
    }
    if (children != null) {
      $result.children.addAll(children);
    }
    return $result;
  }
  Bare._() : super();
  factory Bare.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Bare.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Bare', createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'a')
    ..pc<Bare>(2, _omitFieldNames ? '' : 'children', $pb.PbFieldType.PM, subBuilder: Bare.create)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Bare clone() => Bare()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Bare copyWith(void Function(Bare) updates) => super.copyWith((message) => updates(message as Bare)) as Bare;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Bare create() => Bare._();
  Bare createEmptyInstance() => create();
  static $pb.PbList<Bare> createRepeated() => $pb.PbList<Bare>();
  @$core.pragma('dart2js:noInline')
  static Bare getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Bare>(create);
  static Bare? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get a => $_getSZ(0);
  @$pb.TagNumber(1)
  set a($core.String v) { $_setString(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasA() => $_has(0);
  @$pb.TagNumber(1)
  void clearA() => clearField(1);

  @$pb.TagNumber(2)
  $core.List<Bare> get children => $_getList(1);
}


const _omitFieldNames = $core.bool.fromEnvironment('protobuf.omit_field_names');
const _omitMessageNames = $core.bool.fromEnvironment('protobuf.omit_message_names');
