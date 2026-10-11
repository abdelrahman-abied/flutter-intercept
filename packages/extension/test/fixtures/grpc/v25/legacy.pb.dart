// This is a generated file - do not edit.
//
// Generated from legacy.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports

import 'dart:core' as $core;

import 'package:fixnum/fixnum.dart' as $fixnum;
import 'package:protobuf/protobuf.dart' as $pb;

import 'legacy.pbenum.dart';

export 'package:protobuf/protobuf.dart' show GeneratedMessageGenericExtensions;

export 'legacy.pbenum.dart';

class Legacy_Sub extends $pb.GeneratedMessage {
  factory Legacy_Sub({
    $core.int? v,
  }) {
    final result = Legacy_Sub._();
    if (v != null) result.v = v;
    return result;
  }

  Legacy_Sub._();

  factory Legacy_Sub.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Legacy_Sub()..mergeFromBuffer(data, registry);
  factory Legacy_Sub.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Legacy_Sub()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Legacy.Sub',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.legacy'),
      createEmptyInstance: Legacy_Sub.$_createMessage)
    ..aI(1, _omitFieldNames ? '' : 'v', fieldType: $pb.PbFieldType.Q3);

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Legacy_Sub clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Legacy_Sub copyWith(void Function(Legacy_Sub) updates) =>
      super.copyWith((message) => updates(message as Legacy_Sub)) as Legacy_Sub;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use Legacy_Sub() / Legacy_Sub.new instead')
  static Legacy_Sub create() => Legacy_Sub._();
  static $pb.GeneratedMessage $_createMessage() => Legacy_Sub._();
  @$core.override
  Legacy_Sub createEmptyInstance() => Legacy_Sub._();
  @$core.pragma('dart2js:noInline')
  static Legacy_Sub getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Legacy_Sub>(Legacy_Sub.$_createMessage);
  static Legacy_Sub? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get v => $_getIZ(0);
  @$pb.TagNumber(1)
  set v($core.int value) => $_setSignedInt32(0, value);
  @$pb.TagNumber(1)
  $core.bool hasV() => $_has(0);
  @$pb.TagNumber(1)
  void clearV() => $_clearField(1);
}

class Legacy extends $pb.GeneratedMessage {
  factory Legacy({
    $core.String? id,
    $core.int? count,
    $core.Iterable<$core.int>? nums,
    $core.Iterable<$core.int>? loose,
    Legacy_Kind? kind,
    Legacy_Sub? sub,
    $core.List<$core.int>? data,
    $fixnum.Int64? big,
    $fixnum.Int64? neg,
    $fixnum.Int64? f64,
    $core.double? ratio,
    $core.double? flt,
    $core.Iterable<Legacy_Sub>? subs,
    $core.Iterable<Legacy_Kind>? kinds,
    $core.String? name,
  }) {
    final result = Legacy._();
    if (id != null) result.id = id;
    if (count != null) result.count = count;
    if (nums != null) result.nums.addAll(nums);
    if (loose != null) result.loose.addAll(loose);
    if (kind != null) result.kind = kind;
    if (sub != null) result.sub = sub;
    if (data != null) result.data = data;
    if (big != null) result.big = big;
    if (neg != null) result.neg = neg;
    if (f64 != null) result.f64 = f64;
    if (ratio != null) result.ratio = ratio;
    if (flt != null) result.flt = flt;
    if (subs != null) result.subs.addAll(subs);
    if (kinds != null) result.kinds.addAll(kinds);
    if (name != null) result.name = name;
    return result;
  }

  Legacy._();

  factory Legacy.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Legacy()..mergeFromBuffer(data, registry);
  factory Legacy.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Legacy()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Legacy',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.legacy'),
      createEmptyInstance: Legacy.$_createMessage)
    ..aQS(1, _omitFieldNames ? '' : 'id')
    ..aI(2, _omitFieldNames ? '' : 'count', defaultOrMaker: 7)
    ..p<$core.int>(3, _omitFieldNames ? '' : 'nums', $pb.PbFieldType.K3)
    ..p<$core.int>(4, _omitFieldNames ? '' : 'loose', $pb.PbFieldType.P3)
    ..aE<Legacy_Kind>(5, _omitFieldNames ? '' : 'kind',
        defaultOrMaker: Legacy_Kind.B, enumValues: Legacy_Kind.values)
    ..aQM<Legacy_Sub>(6, _omitFieldNames ? '' : 'sub',
        subBuilder: Legacy_Sub.$_createMessage)
    ..a<$core.List<$core.int>>(
        7, _omitFieldNames ? '' : 'data', $pb.PbFieldType.OY,
        defaultOrMaker: () => <$core.int>[0x61, 0x62, 0x63])
    ..a<$fixnum.Int64>(8, _omitFieldNames ? '' : 'big', $pb.PbFieldType.OU6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$fixnum.Int64>(9, _omitFieldNames ? '' : 'neg', $pb.PbFieldType.OS6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$fixnum.Int64>(10, _omitFieldNames ? '' : 'f64', $pb.PbFieldType.OF6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..aD(11, _omitFieldNames ? '' : 'ratio', defaultOrMaker: 0.5)
    ..aD(12, _omitFieldNames ? '' : 'flt', fieldType: $pb.PbFieldType.OF)
    ..pPM<Legacy_Sub>(13, _omitFieldNames ? '' : 'subs',
        subBuilder: Legacy_Sub.$_createMessage)
    ..pPE<Legacy_Kind>(14, _omitFieldNames ? '' : 'kinds',
        enumValues: Legacy_Kind.values)
    ..a<$core.String>(15, _omitFieldNames ? '' : 'name', $pb.PbFieldType.OS,
        defaultOrMaker: 'none');

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Legacy clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Legacy copyWith(void Function(Legacy) updates) =>
      super.copyWith((message) => updates(message as Legacy)) as Legacy;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use Legacy() / Legacy.new instead')
  static Legacy create() => Legacy._();
  static $pb.GeneratedMessage $_createMessage() => Legacy._();
  @$core.override
  Legacy createEmptyInstance() => Legacy._();
  @$core.pragma('dart2js:noInline')
  static Legacy getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Legacy>(Legacy.$_createMessage);
  static Legacy? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get id => $_getSZ(0);
  @$pb.TagNumber(1)
  set id($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasId() => $_has(0);
  @$pb.TagNumber(1)
  void clearId() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.int get count => $_getI(1, 7);
  @$pb.TagNumber(2)
  set count($core.int value) => $_setSignedInt32(1, value);
  @$pb.TagNumber(2)
  $core.bool hasCount() => $_has(1);
  @$pb.TagNumber(2)
  void clearCount() => $_clearField(2);

  @$pb.TagNumber(3)
  $pb.PbList<$core.int> get nums => $_getList(2);

  @$pb.TagNumber(4)
  $pb.PbList<$core.int> get loose => $_getList(3);

  @$pb.TagNumber(5)
  Legacy_Kind get kind => $_getN(4);
  @$pb.TagNumber(5)
  set kind(Legacy_Kind value) => $_setField(5, value);
  @$pb.TagNumber(5)
  $core.bool hasKind() => $_has(4);
  @$pb.TagNumber(5)
  void clearKind() => $_clearField(5);

  @$pb.TagNumber(6)
  Legacy_Sub get sub => $_getN(5);
  @$pb.TagNumber(6)
  set sub(Legacy_Sub value) => $_setField(6, value);
  @$pb.TagNumber(6)
  $core.bool hasSub() => $_has(5);
  @$pb.TagNumber(6)
  void clearSub() => $_clearField(6);
  @$pb.TagNumber(6)
  Legacy_Sub ensureSub() => $_ensure(5);

  @$pb.TagNumber(7)
  $core.List<$core.int> get data => $_getN(6);
  @$pb.TagNumber(7)
  set data($core.List<$core.int> value) => $_setBytes(6, value);
  @$pb.TagNumber(7)
  $core.bool hasData() => $_has(6);
  @$pb.TagNumber(7)
  void clearData() => $_clearField(7);

  @$pb.TagNumber(8)
  $fixnum.Int64 get big => $_getI64(7);
  @$pb.TagNumber(8)
  set big($fixnum.Int64 value) => $_setInt64(7, value);
  @$pb.TagNumber(8)
  $core.bool hasBig() => $_has(7);
  @$pb.TagNumber(8)
  void clearBig() => $_clearField(8);

  @$pb.TagNumber(9)
  $fixnum.Int64 get neg => $_getI64(8);
  @$pb.TagNumber(9)
  set neg($fixnum.Int64 value) => $_setInt64(8, value);
  @$pb.TagNumber(9)
  $core.bool hasNeg() => $_has(8);
  @$pb.TagNumber(9)
  void clearNeg() => $_clearField(9);

  @$pb.TagNumber(10)
  $fixnum.Int64 get f64 => $_getI64(9);
  @$pb.TagNumber(10)
  set f64($fixnum.Int64 value) => $_setInt64(9, value);
  @$pb.TagNumber(10)
  $core.bool hasF64() => $_has(9);
  @$pb.TagNumber(10)
  void clearF64() => $_clearField(10);

  @$pb.TagNumber(11)
  $core.double get ratio => $_getN(10);
  @$pb.TagNumber(11)
  set ratio($core.double value) => $_setDouble(10, value);
  @$pb.TagNumber(11)
  $core.bool hasRatio() => $_has(10);
  @$pb.TagNumber(11)
  void clearRatio() => $_clearField(11);

  @$pb.TagNumber(12)
  $core.double get flt => $_getN(11);
  @$pb.TagNumber(12)
  set flt($core.double value) => $_setFloat(11, value);
  @$pb.TagNumber(12)
  $core.bool hasFlt() => $_has(11);
  @$pb.TagNumber(12)
  void clearFlt() => $_clearField(12);

  @$pb.TagNumber(13)
  $pb.PbList<Legacy_Sub> get subs => $_getList(12);

  @$pb.TagNumber(14)
  $pb.PbList<Legacy_Kind> get kinds => $_getList(13);

  @$pb.TagNumber(15)
  $core.String get name => $_getS(14, 'none');
  @$pb.TagNumber(15)
  set name($core.String value) => $_setString(14, value);
  @$pb.TagNumber(15)
  $core.bool hasName() => $_has(14);
  @$pb.TagNumber(15)
  void clearName() => $_clearField(15);
}

const $core.bool _omitFieldNames =
    $core.bool.fromEnvironment('protobuf.omit_field_names');
const $core.bool _omitMessageNames =
    $core.bool.fromEnvironment('protobuf.omit_message_names');
