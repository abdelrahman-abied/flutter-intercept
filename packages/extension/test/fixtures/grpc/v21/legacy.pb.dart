//
//  Generated code. Do not modify.
//  source: legacy.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:core' as $core;

import 'package:fixnum/fixnum.dart' as $fixnum;
import 'package:protobuf/protobuf.dart' as $pb;

import 'legacy.pbenum.dart';

export 'legacy.pbenum.dart';

class Legacy_Sub extends $pb.GeneratedMessage {
  factory Legacy_Sub({
    $core.int? v,
  }) {
    final $result = create();
    if (v != null) {
      $result.v = v;
    }
    return $result;
  }
  Legacy_Sub._() : super();
  factory Legacy_Sub.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Legacy_Sub.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Legacy.Sub', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.legacy'), createEmptyInstance: create)
    ..a<$core.int>(1, _omitFieldNames ? '' : 'v', $pb.PbFieldType.Q3)
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Legacy_Sub clone() => Legacy_Sub()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Legacy_Sub copyWith(void Function(Legacy_Sub) updates) => super.copyWith((message) => updates(message as Legacy_Sub)) as Legacy_Sub;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Legacy_Sub create() => Legacy_Sub._();
  Legacy_Sub createEmptyInstance() => create();
  static $pb.PbList<Legacy_Sub> createRepeated() => $pb.PbList<Legacy_Sub>();
  @$core.pragma('dart2js:noInline')
  static Legacy_Sub getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Legacy_Sub>(create);
  static Legacy_Sub? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get v => $_getIZ(0);
  @$pb.TagNumber(1)
  set v($core.int v) { $_setSignedInt32(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasV() => $_has(0);
  @$pb.TagNumber(1)
  void clearV() => clearField(1);
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
    final $result = create();
    if (id != null) {
      $result.id = id;
    }
    if (count != null) {
      $result.count = count;
    }
    if (nums != null) {
      $result.nums.addAll(nums);
    }
    if (loose != null) {
      $result.loose.addAll(loose);
    }
    if (kind != null) {
      $result.kind = kind;
    }
    if (sub != null) {
      $result.sub = sub;
    }
    if (data != null) {
      $result.data = data;
    }
    if (big != null) {
      $result.big = big;
    }
    if (neg != null) {
      $result.neg = neg;
    }
    if (f64 != null) {
      $result.f64 = f64;
    }
    if (ratio != null) {
      $result.ratio = ratio;
    }
    if (flt != null) {
      $result.flt = flt;
    }
    if (subs != null) {
      $result.subs.addAll(subs);
    }
    if (kinds != null) {
      $result.kinds.addAll(kinds);
    }
    if (name != null) {
      $result.name = name;
    }
    return $result;
  }
  Legacy._() : super();
  factory Legacy.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Legacy.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Legacy', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.legacy'), createEmptyInstance: create)
    ..aQS(1, _omitFieldNames ? '' : 'id')
    ..a<$core.int>(2, _omitFieldNames ? '' : 'count', $pb.PbFieldType.O3, defaultOrMaker: 7)
    ..p<$core.int>(3, _omitFieldNames ? '' : 'nums', $pb.PbFieldType.K3)
    ..p<$core.int>(4, _omitFieldNames ? '' : 'loose', $pb.PbFieldType.P3)
    ..e<Legacy_Kind>(5, _omitFieldNames ? '' : 'kind', $pb.PbFieldType.OE, defaultOrMaker: Legacy_Kind.B, valueOf: Legacy_Kind.valueOf, enumValues: Legacy_Kind.values)
    ..aQM<Legacy_Sub>(6, _omitFieldNames ? '' : 'sub', subBuilder: Legacy_Sub.create)
    ..a<$core.List<$core.int>>(7, _omitFieldNames ? '' : 'data', $pb.PbFieldType.OY, defaultOrMaker: () => <$core.int>[0x61,0x62,0x63])
    ..a<$fixnum.Int64>(8, _omitFieldNames ? '' : 'big', $pb.PbFieldType.OU6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$fixnum.Int64>(9, _omitFieldNames ? '' : 'neg', $pb.PbFieldType.OS6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$fixnum.Int64>(10, _omitFieldNames ? '' : 'f64', $pb.PbFieldType.OF6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$core.double>(11, _omitFieldNames ? '' : 'ratio', $pb.PbFieldType.OD, defaultOrMaker: 0.5)
    ..a<$core.double>(12, _omitFieldNames ? '' : 'flt', $pb.PbFieldType.OF)
    ..pc<Legacy_Sub>(13, _omitFieldNames ? '' : 'subs', $pb.PbFieldType.PM, subBuilder: Legacy_Sub.create)
    ..pc<Legacy_Kind>(14, _omitFieldNames ? '' : 'kinds', $pb.PbFieldType.PE, valueOf: Legacy_Kind.valueOf, enumValues: Legacy_Kind.values, defaultEnumValue: Legacy_Kind.A)
    ..a<$core.String>(15, _omitFieldNames ? '' : 'name', $pb.PbFieldType.OS, defaultOrMaker: 'none')
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Legacy clone() => Legacy()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Legacy copyWith(void Function(Legacy) updates) => super.copyWith((message) => updates(message as Legacy)) as Legacy;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Legacy create() => Legacy._();
  Legacy createEmptyInstance() => create();
  static $pb.PbList<Legacy> createRepeated() => $pb.PbList<Legacy>();
  @$core.pragma('dart2js:noInline')
  static Legacy getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Legacy>(create);
  static Legacy? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get id => $_getSZ(0);
  @$pb.TagNumber(1)
  set id($core.String v) { $_setString(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasId() => $_has(0);
  @$pb.TagNumber(1)
  void clearId() => clearField(1);

  @$pb.TagNumber(2)
  $core.int get count => $_getI(1, 7);
  @$pb.TagNumber(2)
  set count($core.int v) { $_setSignedInt32(1, v); }
  @$pb.TagNumber(2)
  $core.bool hasCount() => $_has(1);
  @$pb.TagNumber(2)
  void clearCount() => clearField(2);

  @$pb.TagNumber(3)
  $core.List<$core.int> get nums => $_getList(2);

  @$pb.TagNumber(4)
  $core.List<$core.int> get loose => $_getList(3);

  @$pb.TagNumber(5)
  Legacy_Kind get kind => $_getN(4);
  @$pb.TagNumber(5)
  set kind(Legacy_Kind v) { setField(5, v); }
  @$pb.TagNumber(5)
  $core.bool hasKind() => $_has(4);
  @$pb.TagNumber(5)
  void clearKind() => clearField(5);

  @$pb.TagNumber(6)
  Legacy_Sub get sub => $_getN(5);
  @$pb.TagNumber(6)
  set sub(Legacy_Sub v) { setField(6, v); }
  @$pb.TagNumber(6)
  $core.bool hasSub() => $_has(5);
  @$pb.TagNumber(6)
  void clearSub() => clearField(6);
  @$pb.TagNumber(6)
  Legacy_Sub ensureSub() => $_ensure(5);

  @$pb.TagNumber(7)
  $core.List<$core.int> get data => $_getN(6);
  @$pb.TagNumber(7)
  set data($core.List<$core.int> v) { $_setBytes(6, v); }
  @$pb.TagNumber(7)
  $core.bool hasData() => $_has(6);
  @$pb.TagNumber(7)
  void clearData() => clearField(7);

  @$pb.TagNumber(8)
  $fixnum.Int64 get big => $_getI64(7);
  @$pb.TagNumber(8)
  set big($fixnum.Int64 v) { $_setInt64(7, v); }
  @$pb.TagNumber(8)
  $core.bool hasBig() => $_has(7);
  @$pb.TagNumber(8)
  void clearBig() => clearField(8);

  @$pb.TagNumber(9)
  $fixnum.Int64 get neg => $_getI64(8);
  @$pb.TagNumber(9)
  set neg($fixnum.Int64 v) { $_setInt64(8, v); }
  @$pb.TagNumber(9)
  $core.bool hasNeg() => $_has(8);
  @$pb.TagNumber(9)
  void clearNeg() => clearField(9);

  @$pb.TagNumber(10)
  $fixnum.Int64 get f64 => $_getI64(9);
  @$pb.TagNumber(10)
  set f64($fixnum.Int64 v) { $_setInt64(9, v); }
  @$pb.TagNumber(10)
  $core.bool hasF64() => $_has(9);
  @$pb.TagNumber(10)
  void clearF64() => clearField(10);

  @$pb.TagNumber(11)
  $core.double get ratio => $_getN(10);
  @$pb.TagNumber(11)
  set ratio($core.double v) { $_setDouble(10, v); }
  @$pb.TagNumber(11)
  $core.bool hasRatio() => $_has(10);
  @$pb.TagNumber(11)
  void clearRatio() => clearField(11);

  @$pb.TagNumber(12)
  $core.double get flt => $_getN(11);
  @$pb.TagNumber(12)
  set flt($core.double v) { $_setFloat(11, v); }
  @$pb.TagNumber(12)
  $core.bool hasFlt() => $_has(11);
  @$pb.TagNumber(12)
  void clearFlt() => clearField(12);

  @$pb.TagNumber(13)
  $core.List<Legacy_Sub> get subs => $_getList(12);

  @$pb.TagNumber(14)
  $core.List<Legacy_Kind> get kinds => $_getList(13);

  @$pb.TagNumber(15)
  $core.String get name => $_getS(14, 'none');
  @$pb.TagNumber(15)
  set name($core.String v) { $_setString(14, v); }
  @$pb.TagNumber(15)
  $core.bool hasName() => $_has(14);
  @$pb.TagNumber(15)
  void clearName() => clearField(15);
}


const _omitFieldNames = $core.bool.fromEnvironment('protobuf.omit_field_names');
const _omitMessageNames = $core.bool.fromEnvironment('protobuf.omit_message_names');
