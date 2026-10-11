//
//  Generated code. Do not modify.
//  source: shop.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:core' as $core;

import 'package:fixnum/fixnum.dart' as $fixnum;
import 'package:protobuf/protobuf.dart' as $pb;

import 'common.pb.dart' as $4;
import 'common.pbenum.dart' as $4;
import 'google/protobuf/any.pb.dart' as $10;
import 'google/protobuf/duration.pb.dart' as $6;
import 'google/protobuf/field_mask.pb.dart' as $9;
import 'google/protobuf/struct.pb.dart' as $8;
import 'google/protobuf/timestamp.pb.dart' as $5;
import 'google/protobuf/wrappers.pb.dart' as $7;
import 'shop.pbenum.dart';

export 'shop.pbenum.dart';

class Scalars extends $pb.GeneratedMessage {
  factory Scalars({
    $core.double? d,
    $core.double? f,
    $core.int? i32,
    $fixnum.Int64? i64,
    $core.int? u32,
    $fixnum.Int64? u64,
    $core.int? s32,
    $fixnum.Int64? s64,
    $core.int? fx32,
    $fixnum.Int64? fx64,
    $core.int? sfx32,
    $fixnum.Int64? sfx64,
    $core.bool? b,
    $core.String? s,
    $core.List<$core.int>? by,
    $core.int? optI32,
    $core.String? optS,
    Color? color,
  }) {
    final $result = create();
    if (d != null) {
      $result.d = d;
    }
    if (f != null) {
      $result.f = f;
    }
    if (i32 != null) {
      $result.i32 = i32;
    }
    if (i64 != null) {
      $result.i64 = i64;
    }
    if (u32 != null) {
      $result.u32 = u32;
    }
    if (u64 != null) {
      $result.u64 = u64;
    }
    if (s32 != null) {
      $result.s32 = s32;
    }
    if (s64 != null) {
      $result.s64 = s64;
    }
    if (fx32 != null) {
      $result.fx32 = fx32;
    }
    if (fx64 != null) {
      $result.fx64 = fx64;
    }
    if (sfx32 != null) {
      $result.sfx32 = sfx32;
    }
    if (sfx64 != null) {
      $result.sfx64 = sfx64;
    }
    if (b != null) {
      $result.b = b;
    }
    if (s != null) {
      $result.s = s;
    }
    if (by != null) {
      $result.by = by;
    }
    if (optI32 != null) {
      $result.optI32 = optI32;
    }
    if (optS != null) {
      $result.optS = optS;
    }
    if (color != null) {
      $result.color = color;
    }
    return $result;
  }
  Scalars._() : super();
  factory Scalars.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Scalars.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Scalars', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..a<$core.double>(1, _omitFieldNames ? '' : 'd', $pb.PbFieldType.OD)
    ..a<$core.double>(2, _omitFieldNames ? '' : 'f', $pb.PbFieldType.OF)
    ..a<$core.int>(3, _omitFieldNames ? '' : 'i32', $pb.PbFieldType.O3)
    ..aInt64(4, _omitFieldNames ? '' : 'i64')
    ..a<$core.int>(5, _omitFieldNames ? '' : 'u32', $pb.PbFieldType.OU3)
    ..a<$fixnum.Int64>(6, _omitFieldNames ? '' : 'u64', $pb.PbFieldType.OU6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$core.int>(7, _omitFieldNames ? '' : 's32', $pb.PbFieldType.OS3)
    ..a<$fixnum.Int64>(8, _omitFieldNames ? '' : 's64', $pb.PbFieldType.OS6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$core.int>(9, _omitFieldNames ? '' : 'fx32', $pb.PbFieldType.OF3)
    ..a<$fixnum.Int64>(10, _omitFieldNames ? '' : 'fx64', $pb.PbFieldType.OF6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..a<$core.int>(11, _omitFieldNames ? '' : 'sfx32', $pb.PbFieldType.OSF3)
    ..a<$fixnum.Int64>(12, _omitFieldNames ? '' : 'sfx64', $pb.PbFieldType.OSF6, defaultOrMaker: $fixnum.Int64.ZERO)
    ..aOB(13, _omitFieldNames ? '' : 'b')
    ..aOS(14, _omitFieldNames ? '' : 's')
    ..a<$core.List<$core.int>>(15, _omitFieldNames ? '' : 'by', $pb.PbFieldType.OY)
    ..a<$core.int>(16, _omitFieldNames ? '' : 'optI32', $pb.PbFieldType.O3)
    ..aOS(17, _omitFieldNames ? '' : 'optS')
    ..e<Color>(18, _omitFieldNames ? '' : 'color', $pb.PbFieldType.OE, defaultOrMaker: Color.COLOR_UNSPECIFIED, valueOf: Color.valueOf, enumValues: Color.values)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Scalars clone() => Scalars()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Scalars copyWith(void Function(Scalars) updates) => super.copyWith((message) => updates(message as Scalars)) as Scalars;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Scalars create() => Scalars._();
  Scalars createEmptyInstance() => create();
  static $pb.PbList<Scalars> createRepeated() => $pb.PbList<Scalars>();
  @$core.pragma('dart2js:noInline')
  static Scalars getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Scalars>(create);
  static Scalars? _defaultInstance;

  @$pb.TagNumber(1)
  $core.double get d => $_getN(0);
  @$pb.TagNumber(1)
  set d($core.double v) { $_setDouble(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasD() => $_has(0);
  @$pb.TagNumber(1)
  void clearD() => clearField(1);

  @$pb.TagNumber(2)
  $core.double get f => $_getN(1);
  @$pb.TagNumber(2)
  set f($core.double v) { $_setFloat(1, v); }
  @$pb.TagNumber(2)
  $core.bool hasF() => $_has(1);
  @$pb.TagNumber(2)
  void clearF() => clearField(2);

  @$pb.TagNumber(3)
  $core.int get i32 => $_getIZ(2);
  @$pb.TagNumber(3)
  set i32($core.int v) { $_setSignedInt32(2, v); }
  @$pb.TagNumber(3)
  $core.bool hasI32() => $_has(2);
  @$pb.TagNumber(3)
  void clearI32() => clearField(3);

  @$pb.TagNumber(4)
  $fixnum.Int64 get i64 => $_getI64(3);
  @$pb.TagNumber(4)
  set i64($fixnum.Int64 v) { $_setInt64(3, v); }
  @$pb.TagNumber(4)
  $core.bool hasI64() => $_has(3);
  @$pb.TagNumber(4)
  void clearI64() => clearField(4);

  @$pb.TagNumber(5)
  $core.int get u32 => $_getIZ(4);
  @$pb.TagNumber(5)
  set u32($core.int v) { $_setUnsignedInt32(4, v); }
  @$pb.TagNumber(5)
  $core.bool hasU32() => $_has(4);
  @$pb.TagNumber(5)
  void clearU32() => clearField(5);

  @$pb.TagNumber(6)
  $fixnum.Int64 get u64 => $_getI64(5);
  @$pb.TagNumber(6)
  set u64($fixnum.Int64 v) { $_setInt64(5, v); }
  @$pb.TagNumber(6)
  $core.bool hasU64() => $_has(5);
  @$pb.TagNumber(6)
  void clearU64() => clearField(6);

  @$pb.TagNumber(7)
  $core.int get s32 => $_getIZ(6);
  @$pb.TagNumber(7)
  set s32($core.int v) { $_setSignedInt32(6, v); }
  @$pb.TagNumber(7)
  $core.bool hasS32() => $_has(6);
  @$pb.TagNumber(7)
  void clearS32() => clearField(7);

  @$pb.TagNumber(8)
  $fixnum.Int64 get s64 => $_getI64(7);
  @$pb.TagNumber(8)
  set s64($fixnum.Int64 v) { $_setInt64(7, v); }
  @$pb.TagNumber(8)
  $core.bool hasS64() => $_has(7);
  @$pb.TagNumber(8)
  void clearS64() => clearField(8);

  @$pb.TagNumber(9)
  $core.int get fx32 => $_getIZ(8);
  @$pb.TagNumber(9)
  set fx32($core.int v) { $_setUnsignedInt32(8, v); }
  @$pb.TagNumber(9)
  $core.bool hasFx32() => $_has(8);
  @$pb.TagNumber(9)
  void clearFx32() => clearField(9);

  @$pb.TagNumber(10)
  $fixnum.Int64 get fx64 => $_getI64(9);
  @$pb.TagNumber(10)
  set fx64($fixnum.Int64 v) { $_setInt64(9, v); }
  @$pb.TagNumber(10)
  $core.bool hasFx64() => $_has(9);
  @$pb.TagNumber(10)
  void clearFx64() => clearField(10);

  @$pb.TagNumber(11)
  $core.int get sfx32 => $_getIZ(10);
  @$pb.TagNumber(11)
  set sfx32($core.int v) { $_setSignedInt32(10, v); }
  @$pb.TagNumber(11)
  $core.bool hasSfx32() => $_has(10);
  @$pb.TagNumber(11)
  void clearSfx32() => clearField(11);

  @$pb.TagNumber(12)
  $fixnum.Int64 get sfx64 => $_getI64(11);
  @$pb.TagNumber(12)
  set sfx64($fixnum.Int64 v) { $_setInt64(11, v); }
  @$pb.TagNumber(12)
  $core.bool hasSfx64() => $_has(11);
  @$pb.TagNumber(12)
  void clearSfx64() => clearField(12);

  @$pb.TagNumber(13)
  $core.bool get b => $_getBF(12);
  @$pb.TagNumber(13)
  set b($core.bool v) { $_setBool(12, v); }
  @$pb.TagNumber(13)
  $core.bool hasB() => $_has(12);
  @$pb.TagNumber(13)
  void clearB() => clearField(13);

  @$pb.TagNumber(14)
  $core.String get s => $_getSZ(13);
  @$pb.TagNumber(14)
  set s($core.String v) { $_setString(13, v); }
  @$pb.TagNumber(14)
  $core.bool hasS() => $_has(13);
  @$pb.TagNumber(14)
  void clearS() => clearField(14);

  @$pb.TagNumber(15)
  $core.List<$core.int> get by => $_getN(14);
  @$pb.TagNumber(15)
  set by($core.List<$core.int> v) { $_setBytes(14, v); }
  @$pb.TagNumber(15)
  $core.bool hasBy() => $_has(14);
  @$pb.TagNumber(15)
  void clearBy() => clearField(15);

  @$pb.TagNumber(16)
  $core.int get optI32 => $_getIZ(15);
  @$pb.TagNumber(16)
  set optI32($core.int v) { $_setSignedInt32(15, v); }
  @$pb.TagNumber(16)
  $core.bool hasOptI32() => $_has(15);
  @$pb.TagNumber(16)
  void clearOptI32() => clearField(16);

  @$pb.TagNumber(17)
  $core.String get optS => $_getSZ(16);
  @$pb.TagNumber(17)
  set optS($core.String v) { $_setString(16, v); }
  @$pb.TagNumber(17)
  $core.bool hasOptS() => $_has(16);
  @$pb.TagNumber(17)
  void clearOptS() => clearField(17);

  @$pb.TagNumber(18)
  Color get color => $_getN(17);
  @$pb.TagNumber(18)
  set color(Color v) { setField(18, v); }
  @$pb.TagNumber(18)
  $core.bool hasColor() => $_has(17);
  @$pb.TagNumber(18)
  void clearColor() => clearField(18);
}

class Repeats extends $pb.GeneratedMessage {
  factory Repeats({
    $core.Iterable<$core.double>? d,
    $core.Iterable<$core.double>? f,
    $core.Iterable<$core.int>? i32,
    $core.Iterable<$fixnum.Int64>? i64,
    $core.Iterable<$core.int>? u32,
    $core.Iterable<$fixnum.Int64>? u64,
    $core.Iterable<$core.int>? s32,
    $core.Iterable<$fixnum.Int64>? s64,
    $core.Iterable<$core.int>? fx32,
    $core.Iterable<$fixnum.Int64>? fx64,
    $core.Iterable<$core.int>? sfx32,
    $core.Iterable<$fixnum.Int64>? sfx64,
    $core.Iterable<$core.bool>? b,
    $core.Iterable<$core.String>? s,
    $core.Iterable<$core.List<$core.int>>? by,
    $core.Iterable<Color>? colors,
    $core.Iterable<$4.Money>? moneys,
    $core.Iterable<$core.int>? unpacked,
  }) {
    final $result = create();
    if (d != null) {
      $result.d.addAll(d);
    }
    if (f != null) {
      $result.f.addAll(f);
    }
    if (i32 != null) {
      $result.i32.addAll(i32);
    }
    if (i64 != null) {
      $result.i64.addAll(i64);
    }
    if (u32 != null) {
      $result.u32.addAll(u32);
    }
    if (u64 != null) {
      $result.u64.addAll(u64);
    }
    if (s32 != null) {
      $result.s32.addAll(s32);
    }
    if (s64 != null) {
      $result.s64.addAll(s64);
    }
    if (fx32 != null) {
      $result.fx32.addAll(fx32);
    }
    if (fx64 != null) {
      $result.fx64.addAll(fx64);
    }
    if (sfx32 != null) {
      $result.sfx32.addAll(sfx32);
    }
    if (sfx64 != null) {
      $result.sfx64.addAll(sfx64);
    }
    if (b != null) {
      $result.b.addAll(b);
    }
    if (s != null) {
      $result.s.addAll(s);
    }
    if (by != null) {
      $result.by.addAll(by);
    }
    if (colors != null) {
      $result.colors.addAll(colors);
    }
    if (moneys != null) {
      $result.moneys.addAll(moneys);
    }
    if (unpacked != null) {
      $result.unpacked.addAll(unpacked);
    }
    return $result;
  }
  Repeats._() : super();
  factory Repeats.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Repeats.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Repeats', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..p<$core.double>(1, _omitFieldNames ? '' : 'd', $pb.PbFieldType.KD)
    ..p<$core.double>(2, _omitFieldNames ? '' : 'f', $pb.PbFieldType.KF)
    ..p<$core.int>(3, _omitFieldNames ? '' : 'i32', $pb.PbFieldType.K3)
    ..p<$fixnum.Int64>(4, _omitFieldNames ? '' : 'i64', $pb.PbFieldType.K6)
    ..p<$core.int>(5, _omitFieldNames ? '' : 'u32', $pb.PbFieldType.KU3)
    ..p<$fixnum.Int64>(6, _omitFieldNames ? '' : 'u64', $pb.PbFieldType.KU6)
    ..p<$core.int>(7, _omitFieldNames ? '' : 's32', $pb.PbFieldType.KS3)
    ..p<$fixnum.Int64>(8, _omitFieldNames ? '' : 's64', $pb.PbFieldType.KS6)
    ..p<$core.int>(9, _omitFieldNames ? '' : 'fx32', $pb.PbFieldType.KF3)
    ..p<$fixnum.Int64>(10, _omitFieldNames ? '' : 'fx64', $pb.PbFieldType.KF6)
    ..p<$core.int>(11, _omitFieldNames ? '' : 'sfx32', $pb.PbFieldType.KSF3)
    ..p<$fixnum.Int64>(12, _omitFieldNames ? '' : 'sfx64', $pb.PbFieldType.KSF6)
    ..p<$core.bool>(13, _omitFieldNames ? '' : 'b', $pb.PbFieldType.KB)
    ..pPS(14, _omitFieldNames ? '' : 's')
    ..p<$core.List<$core.int>>(15, _omitFieldNames ? '' : 'by', $pb.PbFieldType.PY)
    ..pc<Color>(16, _omitFieldNames ? '' : 'colors', $pb.PbFieldType.KE, valueOf: Color.valueOf, enumValues: Color.values, defaultEnumValue: Color.COLOR_UNSPECIFIED)
    ..pc<$4.Money>(17, _omitFieldNames ? '' : 'moneys', $pb.PbFieldType.PM, subBuilder: $4.Money.create)
    ..p<$core.int>(18, _omitFieldNames ? '' : 'unpacked', $pb.PbFieldType.P3)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Repeats clone() => Repeats()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Repeats copyWith(void Function(Repeats) updates) => super.copyWith((message) => updates(message as Repeats)) as Repeats;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Repeats create() => Repeats._();
  Repeats createEmptyInstance() => create();
  static $pb.PbList<Repeats> createRepeated() => $pb.PbList<Repeats>();
  @$core.pragma('dart2js:noInline')
  static Repeats getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Repeats>(create);
  static Repeats? _defaultInstance;

  @$pb.TagNumber(1)
  $core.List<$core.double> get d => $_getList(0);

  @$pb.TagNumber(2)
  $core.List<$core.double> get f => $_getList(1);

  @$pb.TagNumber(3)
  $core.List<$core.int> get i32 => $_getList(2);

  @$pb.TagNumber(4)
  $core.List<$fixnum.Int64> get i64 => $_getList(3);

  @$pb.TagNumber(5)
  $core.List<$core.int> get u32 => $_getList(4);

  @$pb.TagNumber(6)
  $core.List<$fixnum.Int64> get u64 => $_getList(5);

  @$pb.TagNumber(7)
  $core.List<$core.int> get s32 => $_getList(6);

  @$pb.TagNumber(8)
  $core.List<$fixnum.Int64> get s64 => $_getList(7);

  @$pb.TagNumber(9)
  $core.List<$core.int> get fx32 => $_getList(8);

  @$pb.TagNumber(10)
  $core.List<$fixnum.Int64> get fx64 => $_getList(9);

  @$pb.TagNumber(11)
  $core.List<$core.int> get sfx32 => $_getList(10);

  @$pb.TagNumber(12)
  $core.List<$fixnum.Int64> get sfx64 => $_getList(11);

  @$pb.TagNumber(13)
  $core.List<$core.bool> get b => $_getList(12);

  @$pb.TagNumber(14)
  $core.List<$core.String> get s => $_getList(13);

  @$pb.TagNumber(15)
  $core.List<$core.List<$core.int>> get by => $_getList(14);

  @$pb.TagNumber(16)
  $core.List<Color> get colors => $_getList(15);

  @$pb.TagNumber(17)
  $core.List<$4.Money> get moneys => $_getList(16);

  @$pb.TagNumber(18)
  $core.List<$core.int> get unpacked => $_getList(17);
}

class Order_Line_Note extends $pb.GeneratedMessage {
  factory Order_Line_Note({
    $core.String? text,
  }) {
    final $result = create();
    if (text != null) {
      $result.text = text;
    }
    return $result;
  }
  Order_Line_Note._() : super();
  factory Order_Line_Note.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Order_Line_Note.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Order.Line.Note', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'text')
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Order_Line_Note clone() => Order_Line_Note()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Order_Line_Note copyWith(void Function(Order_Line_Note) updates) => super.copyWith((message) => updates(message as Order_Line_Note)) as Order_Line_Note;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Order_Line_Note create() => Order_Line_Note._();
  Order_Line_Note createEmptyInstance() => create();
  static $pb.PbList<Order_Line_Note> createRepeated() => $pb.PbList<Order_Line_Note>();
  @$core.pragma('dart2js:noInline')
  static Order_Line_Note getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Order_Line_Note>(create);
  static Order_Line_Note? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get text => $_getSZ(0);
  @$pb.TagNumber(1)
  set text($core.String v) { $_setString(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasText() => $_has(0);
  @$pb.TagNumber(1)
  void clearText() => clearField(1);
}

class Order_Line extends $pb.GeneratedMessage {
  factory Order_Line({
    $core.String? sku,
    $core.int? qty,
    $4.Money? price,
    Order_Line_Kind? kind,
    $core.Iterable<Order_Line_Note>? notes,
  }) {
    final $result = create();
    if (sku != null) {
      $result.sku = sku;
    }
    if (qty != null) {
      $result.qty = qty;
    }
    if (price != null) {
      $result.price = price;
    }
    if (kind != null) {
      $result.kind = kind;
    }
    if (notes != null) {
      $result.notes.addAll(notes);
    }
    return $result;
  }
  Order_Line._() : super();
  factory Order_Line.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Order_Line.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Order.Line', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'sku')
    ..a<$core.int>(2, _omitFieldNames ? '' : 'qty', $pb.PbFieldType.O3)
    ..aOM<$4.Money>(3, _omitFieldNames ? '' : 'price', subBuilder: $4.Money.create)
    ..e<Order_Line_Kind>(4, _omitFieldNames ? '' : 'kind', $pb.PbFieldType.OE, defaultOrMaker: Order_Line_Kind.KIND_UNSPECIFIED, valueOf: Order_Line_Kind.valueOf, enumValues: Order_Line_Kind.values)
    ..pc<Order_Line_Note>(5, _omitFieldNames ? '' : 'notes', $pb.PbFieldType.PM, subBuilder: Order_Line_Note.create)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Order_Line clone() => Order_Line()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Order_Line copyWith(void Function(Order_Line) updates) => super.copyWith((message) => updates(message as Order_Line)) as Order_Line;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Order_Line create() => Order_Line._();
  Order_Line createEmptyInstance() => create();
  static $pb.PbList<Order_Line> createRepeated() => $pb.PbList<Order_Line>();
  @$core.pragma('dart2js:noInline')
  static Order_Line getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Order_Line>(create);
  static Order_Line? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get sku => $_getSZ(0);
  @$pb.TagNumber(1)
  set sku($core.String v) { $_setString(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasSku() => $_has(0);
  @$pb.TagNumber(1)
  void clearSku() => clearField(1);

  @$pb.TagNumber(2)
  $core.int get qty => $_getIZ(1);
  @$pb.TagNumber(2)
  set qty($core.int v) { $_setSignedInt32(1, v); }
  @$pb.TagNumber(2)
  $core.bool hasQty() => $_has(1);
  @$pb.TagNumber(2)
  void clearQty() => clearField(2);

  @$pb.TagNumber(3)
  $4.Money get price => $_getN(2);
  @$pb.TagNumber(3)
  set price($4.Money v) { setField(3, v); }
  @$pb.TagNumber(3)
  $core.bool hasPrice() => $_has(2);
  @$pb.TagNumber(3)
  void clearPrice() => clearField(3);
  @$pb.TagNumber(3)
  $4.Money ensurePrice() => $_ensure(2);

  @$pb.TagNumber(4)
  Order_Line_Kind get kind => $_getN(3);
  @$pb.TagNumber(4)
  set kind(Order_Line_Kind v) { setField(4, v); }
  @$pb.TagNumber(4)
  $core.bool hasKind() => $_has(3);
  @$pb.TagNumber(4)
  void clearKind() => clearField(4);

  @$pb.TagNumber(5)
  $core.List<Order_Line_Note> get notes => $_getList(4);
}

enum Order_Payment {
  cardToken, 
  cash, 
  invoice, 
  notSet
}

class Order extends $pb.GeneratedMessage {
  factory Order({
    $core.String? orderId,
    $core.Iterable<Order_Line>? lines,
    $core.Map<$core.String, $core.String>? labels,
    $core.Map<$core.int, Order_Line>? linesByNo,
    $core.Map<$core.String, Color>? colorsByName,
    $core.Map<$fixnum.Int64, $core.bool>? flags,
    $core.Map<$core.bool, $core.List<$core.int>>? blobs,
    $core.Map<$fixnum.Int64, $4.Level>? levels,
    $core.String? cardToken,
    $4.Money? cash,
    $core.bool? invoice,
    $5.Timestamp? createdAt,
    $6.Duration? ttl,
    $7.StringValue? note,
    $7.Int64Value? big,
    $8.Struct? meta,
    $8.Value? anyValue,
    $9.FieldMask? mask,
    $10.Any? extra,
    $7.BoolValue? gift,
    Order? parent,
    $4.Level? level,
    $core.String? class_31,
    $core.String? custom,
    $8.ListValue? listValue,
    $7.BytesValue? rawValue,
  }) {
    final $result = create();
    if (orderId != null) {
      $result.orderId = orderId;
    }
    if (lines != null) {
      $result.lines.addAll(lines);
    }
    if (labels != null) {
      $result.labels.addAll(labels);
    }
    if (linesByNo != null) {
      $result.linesByNo.addAll(linesByNo);
    }
    if (colorsByName != null) {
      $result.colorsByName.addAll(colorsByName);
    }
    if (flags != null) {
      $result.flags.addAll(flags);
    }
    if (blobs != null) {
      $result.blobs.addAll(blobs);
    }
    if (levels != null) {
      $result.levels.addAll(levels);
    }
    if (cardToken != null) {
      $result.cardToken = cardToken;
    }
    if (cash != null) {
      $result.cash = cash;
    }
    if (invoice != null) {
      $result.invoice = invoice;
    }
    if (createdAt != null) {
      $result.createdAt = createdAt;
    }
    if (ttl != null) {
      $result.ttl = ttl;
    }
    if (note != null) {
      $result.note = note;
    }
    if (big != null) {
      $result.big = big;
    }
    if (meta != null) {
      $result.meta = meta;
    }
    if (anyValue != null) {
      $result.anyValue = anyValue;
    }
    if (mask != null) {
      $result.mask = mask;
    }
    if (extra != null) {
      $result.extra = extra;
    }
    if (gift != null) {
      $result.gift = gift;
    }
    if (parent != null) {
      $result.parent = parent;
    }
    if (level != null) {
      $result.level = level;
    }
    if (class_31 != null) {
      $result.class_31 = class_31;
    }
    if (custom != null) {
      $result.custom = custom;
    }
    if (listValue != null) {
      $result.listValue = listValue;
    }
    if (rawValue != null) {
      $result.rawValue = rawValue;
    }
    return $result;
  }
  Order._() : super();
  factory Order.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Order.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static const $core.Map<$core.int, Order_Payment> _Order_PaymentByTag = {
    10 : Order_Payment.cardToken,
    11 : Order_Payment.cash,
    12 : Order_Payment.invoice,
    0 : Order_Payment.notSet
  };
  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Order', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..oo(0, [10, 11, 12])
    ..aOS(1, _omitFieldNames ? '' : 'orderId')
    ..pc<Order_Line>(2, _omitFieldNames ? '' : 'lines', $pb.PbFieldType.PM, subBuilder: Order_Line.create)
    ..m<$core.String, $core.String>(3, _omitFieldNames ? '' : 'labels', entryClassName: 'Order.LabelsEntry', keyFieldType: $pb.PbFieldType.OS, valueFieldType: $pb.PbFieldType.OS, packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$core.int, Order_Line>(4, _omitFieldNames ? '' : 'linesByNo', entryClassName: 'Order.LinesByNoEntry', keyFieldType: $pb.PbFieldType.O3, valueFieldType: $pb.PbFieldType.OM, valueCreator: Order_Line.create, valueDefaultOrMaker: Order_Line.getDefault, packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$core.String, Color>(5, _omitFieldNames ? '' : 'colorsByName', entryClassName: 'Order.ColorsByNameEntry', keyFieldType: $pb.PbFieldType.OS, valueFieldType: $pb.PbFieldType.OE, valueOf: Color.valueOf, enumValues: Color.values, valueDefaultOrMaker: Color.COLOR_UNSPECIFIED, defaultEnumValue: Color.COLOR_UNSPECIFIED, packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$fixnum.Int64, $core.bool>(6, _omitFieldNames ? '' : 'flags', entryClassName: 'Order.FlagsEntry', keyFieldType: $pb.PbFieldType.O6, valueFieldType: $pb.PbFieldType.OB, packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$core.bool, $core.List<$core.int>>(7, _omitFieldNames ? '' : 'blobs', entryClassName: 'Order.BlobsEntry', keyFieldType: $pb.PbFieldType.OB, valueFieldType: $pb.PbFieldType.OY, packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$fixnum.Int64, $4.Level>(8, _omitFieldNames ? '' : 'levels', entryClassName: 'Order.LevelsEntry', keyFieldType: $pb.PbFieldType.OU6, valueFieldType: $pb.PbFieldType.OE, valueOf: $4.Level.valueOf, enumValues: $4.Level.values, valueDefaultOrMaker: $4.Level.LEVEL_UNSPECIFIED, defaultEnumValue: $4.Level.LEVEL_UNSPECIFIED, packageName: const $pb.PackageName('fi.shop.v1'))
    ..aOS(10, _omitFieldNames ? '' : 'cardToken')
    ..aOM<$4.Money>(11, _omitFieldNames ? '' : 'cash', subBuilder: $4.Money.create)
    ..aOB(12, _omitFieldNames ? '' : 'invoice')
    ..aOM<$5.Timestamp>(20, _omitFieldNames ? '' : 'createdAt', subBuilder: $5.Timestamp.create)
    ..aOM<$6.Duration>(21, _omitFieldNames ? '' : 'ttl', subBuilder: $6.Duration.create)
    ..aOM<$7.StringValue>(22, _omitFieldNames ? '' : 'note', subBuilder: $7.StringValue.create)
    ..aOM<$7.Int64Value>(23, _omitFieldNames ? '' : 'big', subBuilder: $7.Int64Value.create)
    ..aOM<$8.Struct>(24, _omitFieldNames ? '' : 'meta', subBuilder: $8.Struct.create)
    ..aOM<$8.Value>(25, _omitFieldNames ? '' : 'anyValue', subBuilder: $8.Value.create)
    ..aOM<$9.FieldMask>(26, _omitFieldNames ? '' : 'mask', subBuilder: $9.FieldMask.create)
    ..aOM<$10.Any>(27, _omitFieldNames ? '' : 'extra', subBuilder: $10.Any.create)
    ..aOM<$7.BoolValue>(28, _omitFieldNames ? '' : 'gift', subBuilder: $7.BoolValue.create)
    ..aOM<Order>(29, _omitFieldNames ? '' : 'parent', subBuilder: Order.create)
    ..e<$4.Level>(30, _omitFieldNames ? '' : 'level', $pb.PbFieldType.OE, defaultOrMaker: $4.Level.LEVEL_UNSPECIFIED, valueOf: $4.Level.valueOf, enumValues: $4.Level.values)
    ..aOS(31, _omitFieldNames ? '' : 'class')
    ..aOS(32, _omitFieldNames ? '' : 'customJson', protoName: 'custom')
    ..aOM<$8.ListValue>(33, _omitFieldNames ? '' : 'listValue', subBuilder: $8.ListValue.create)
    ..aOM<$7.BytesValue>(34, _omitFieldNames ? '' : 'rawValue', subBuilder: $7.BytesValue.create)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Order clone() => Order()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Order copyWith(void Function(Order) updates) => super.copyWith((message) => updates(message as Order)) as Order;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Order create() => Order._();
  Order createEmptyInstance() => create();
  static $pb.PbList<Order> createRepeated() => $pb.PbList<Order>();
  @$core.pragma('dart2js:noInline')
  static Order getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Order>(create);
  static Order? _defaultInstance;

  Order_Payment whichPayment() => _Order_PaymentByTag[$_whichOneof(0)]!;
  void clearPayment() => clearField($_whichOneof(0));

  @$pb.TagNumber(1)
  $core.String get orderId => $_getSZ(0);
  @$pb.TagNumber(1)
  set orderId($core.String v) { $_setString(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasOrderId() => $_has(0);
  @$pb.TagNumber(1)
  void clearOrderId() => clearField(1);

  @$pb.TagNumber(2)
  $core.List<Order_Line> get lines => $_getList(1);

  @$pb.TagNumber(3)
  $core.Map<$core.String, $core.String> get labels => $_getMap(2);

  @$pb.TagNumber(4)
  $core.Map<$core.int, Order_Line> get linesByNo => $_getMap(3);

  @$pb.TagNumber(5)
  $core.Map<$core.String, Color> get colorsByName => $_getMap(4);

  @$pb.TagNumber(6)
  $core.Map<$fixnum.Int64, $core.bool> get flags => $_getMap(5);

  @$pb.TagNumber(7)
  $core.Map<$core.bool, $core.List<$core.int>> get blobs => $_getMap(6);

  @$pb.TagNumber(8)
  $core.Map<$fixnum.Int64, $4.Level> get levels => $_getMap(7);

  @$pb.TagNumber(10)
  $core.String get cardToken => $_getSZ(8);
  @$pb.TagNumber(10)
  set cardToken($core.String v) { $_setString(8, v); }
  @$pb.TagNumber(10)
  $core.bool hasCardToken() => $_has(8);
  @$pb.TagNumber(10)
  void clearCardToken() => clearField(10);

  @$pb.TagNumber(11)
  $4.Money get cash => $_getN(9);
  @$pb.TagNumber(11)
  set cash($4.Money v) { setField(11, v); }
  @$pb.TagNumber(11)
  $core.bool hasCash() => $_has(9);
  @$pb.TagNumber(11)
  void clearCash() => clearField(11);
  @$pb.TagNumber(11)
  $4.Money ensureCash() => $_ensure(9);

  @$pb.TagNumber(12)
  $core.bool get invoice => $_getBF(10);
  @$pb.TagNumber(12)
  set invoice($core.bool v) { $_setBool(10, v); }
  @$pb.TagNumber(12)
  $core.bool hasInvoice() => $_has(10);
  @$pb.TagNumber(12)
  void clearInvoice() => clearField(12);

  @$pb.TagNumber(20)
  $5.Timestamp get createdAt => $_getN(11);
  @$pb.TagNumber(20)
  set createdAt($5.Timestamp v) { setField(20, v); }
  @$pb.TagNumber(20)
  $core.bool hasCreatedAt() => $_has(11);
  @$pb.TagNumber(20)
  void clearCreatedAt() => clearField(20);
  @$pb.TagNumber(20)
  $5.Timestamp ensureCreatedAt() => $_ensure(11);

  @$pb.TagNumber(21)
  $6.Duration get ttl => $_getN(12);
  @$pb.TagNumber(21)
  set ttl($6.Duration v) { setField(21, v); }
  @$pb.TagNumber(21)
  $core.bool hasTtl() => $_has(12);
  @$pb.TagNumber(21)
  void clearTtl() => clearField(21);
  @$pb.TagNumber(21)
  $6.Duration ensureTtl() => $_ensure(12);

  @$pb.TagNumber(22)
  $7.StringValue get note => $_getN(13);
  @$pb.TagNumber(22)
  set note($7.StringValue v) { setField(22, v); }
  @$pb.TagNumber(22)
  $core.bool hasNote() => $_has(13);
  @$pb.TagNumber(22)
  void clearNote() => clearField(22);
  @$pb.TagNumber(22)
  $7.StringValue ensureNote() => $_ensure(13);

  @$pb.TagNumber(23)
  $7.Int64Value get big => $_getN(14);
  @$pb.TagNumber(23)
  set big($7.Int64Value v) { setField(23, v); }
  @$pb.TagNumber(23)
  $core.bool hasBig() => $_has(14);
  @$pb.TagNumber(23)
  void clearBig() => clearField(23);
  @$pb.TagNumber(23)
  $7.Int64Value ensureBig() => $_ensure(14);

  @$pb.TagNumber(24)
  $8.Struct get meta => $_getN(15);
  @$pb.TagNumber(24)
  set meta($8.Struct v) { setField(24, v); }
  @$pb.TagNumber(24)
  $core.bool hasMeta() => $_has(15);
  @$pb.TagNumber(24)
  void clearMeta() => clearField(24);
  @$pb.TagNumber(24)
  $8.Struct ensureMeta() => $_ensure(15);

  @$pb.TagNumber(25)
  $8.Value get anyValue => $_getN(16);
  @$pb.TagNumber(25)
  set anyValue($8.Value v) { setField(25, v); }
  @$pb.TagNumber(25)
  $core.bool hasAnyValue() => $_has(16);
  @$pb.TagNumber(25)
  void clearAnyValue() => clearField(25);
  @$pb.TagNumber(25)
  $8.Value ensureAnyValue() => $_ensure(16);

  @$pb.TagNumber(26)
  $9.FieldMask get mask => $_getN(17);
  @$pb.TagNumber(26)
  set mask($9.FieldMask v) { setField(26, v); }
  @$pb.TagNumber(26)
  $core.bool hasMask() => $_has(17);
  @$pb.TagNumber(26)
  void clearMask() => clearField(26);
  @$pb.TagNumber(26)
  $9.FieldMask ensureMask() => $_ensure(17);

  @$pb.TagNumber(27)
  $10.Any get extra => $_getN(18);
  @$pb.TagNumber(27)
  set extra($10.Any v) { setField(27, v); }
  @$pb.TagNumber(27)
  $core.bool hasExtra() => $_has(18);
  @$pb.TagNumber(27)
  void clearExtra() => clearField(27);
  @$pb.TagNumber(27)
  $10.Any ensureExtra() => $_ensure(18);

  @$pb.TagNumber(28)
  $7.BoolValue get gift => $_getN(19);
  @$pb.TagNumber(28)
  set gift($7.BoolValue v) { setField(28, v); }
  @$pb.TagNumber(28)
  $core.bool hasGift() => $_has(19);
  @$pb.TagNumber(28)
  void clearGift() => clearField(28);
  @$pb.TagNumber(28)
  $7.BoolValue ensureGift() => $_ensure(19);

  @$pb.TagNumber(29)
  Order get parent => $_getN(20);
  @$pb.TagNumber(29)
  set parent(Order v) { setField(29, v); }
  @$pb.TagNumber(29)
  $core.bool hasParent() => $_has(20);
  @$pb.TagNumber(29)
  void clearParent() => clearField(29);
  @$pb.TagNumber(29)
  Order ensureParent() => $_ensure(20);

  @$pb.TagNumber(30)
  $4.Level get level => $_getN(21);
  @$pb.TagNumber(30)
  set level($4.Level v) { setField(30, v); }
  @$pb.TagNumber(30)
  $core.bool hasLevel() => $_has(21);
  @$pb.TagNumber(30)
  void clearLevel() => clearField(30);

  @$pb.TagNumber(31)
  $core.String get class_31 => $_getSZ(22);
  @$pb.TagNumber(31)
  set class_31($core.String v) { $_setString(22, v); }
  @$pb.TagNumber(31)
  $core.bool hasClass_31() => $_has(22);
  @$pb.TagNumber(31)
  void clearClass_31() => clearField(31);

  @$pb.TagNumber(32)
  $core.String get custom => $_getSZ(23);
  @$pb.TagNumber(32)
  set custom($core.String v) { $_setString(23, v); }
  @$pb.TagNumber(32)
  $core.bool hasCustom() => $_has(23);
  @$pb.TagNumber(32)
  void clearCustom() => clearField(32);

  @$pb.TagNumber(33)
  $8.ListValue get listValue => $_getN(24);
  @$pb.TagNumber(33)
  set listValue($8.ListValue v) { setField(33, v); }
  @$pb.TagNumber(33)
  $core.bool hasListValue() => $_has(24);
  @$pb.TagNumber(33)
  void clearListValue() => clearField(33);
  @$pb.TagNumber(33)
  $8.ListValue ensureListValue() => $_ensure(24);

  @$pb.TagNumber(34)
  $7.BytesValue get rawValue => $_getN(25);
  @$pb.TagNumber(34)
  set rawValue($7.BytesValue v) { setField(34, v); }
  @$pb.TagNumber(34)
  $core.bool hasRawValue() => $_has(25);
  @$pb.TagNumber(34)
  void clearRawValue() => clearField(34);
  @$pb.TagNumber(34)
  $7.BytesValue ensureRawValue() => $_ensure(25);
}

/// A message whose name clashes with a Dart core type.
class List_ extends $pb.GeneratedMessage {
  factory List_({
    $core.int? x,
  }) {
    final $result = create();
    if (x != null) {
      $result.x = x;
    }
    return $result;
  }
  List_._() : super();
  factory List_.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory List_.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'List', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..a<$core.int>(1, _omitFieldNames ? '' : 'x', $pb.PbFieldType.O3)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  List_ clone() => List_()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  List_ copyWith(void Function(List_) updates) => super.copyWith((message) => updates(message as List_)) as List_;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static List_ create() => List_._();
  List_ createEmptyInstance() => create();
  static $pb.PbList<List_> createRepeated() => $pb.PbList<List_>();
  @$core.pragma('dart2js:noInline')
  static List_ getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<List_>(create);
  static List_? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get x => $_getIZ(0);
  @$pb.TagNumber(1)
  set x($core.int v) { $_setSignedInt32(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasX() => $_has(0);
  @$pb.TagNumber(1)
  void clearX() => clearField(1);
}

/// A top-level message whose Dart class looks like a nested one.
class Outer_Inner extends $pb.GeneratedMessage {
  factory Outer_Inner({
    $core.int? y,
  }) {
    final $result = create();
    if (y != null) {
      $result.y = y;
    }
    return $result;
  }
  Outer_Inner._() : super();
  factory Outer_Inner.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Outer_Inner.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Outer_Inner', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..a<$core.int>(1, _omitFieldNames ? '' : 'y', $pb.PbFieldType.O3)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Outer_Inner clone() => Outer_Inner()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Outer_Inner copyWith(void Function(Outer_Inner) updates) => super.copyWith((message) => updates(message as Outer_Inner)) as Outer_Inner;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Outer_Inner create() => Outer_Inner._();
  Outer_Inner createEmptyInstance() => create();
  static $pb.PbList<Outer_Inner> createRepeated() => $pb.PbList<Outer_Inner>();
  @$core.pragma('dart2js:noInline')
  static Outer_Inner getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Outer_Inner>(create);
  static Outer_Inner? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get y => $_getIZ(0);
  @$pb.TagNumber(1)
  set y($core.int v) { $_setSignedInt32(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasY() => $_has(0);
  @$pb.TagNumber(1)
  void clearY() => clearField(1);
}

class Outer_Inner_ extends $pb.GeneratedMessage {
  factory Outer_Inner_({
    $core.int? z,
  }) {
    final $result = create();
    if (z != null) {
      $result.z = z;
    }
    return $result;
  }
  Outer_Inner_._() : super();
  factory Outer_Inner_.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Outer_Inner_.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Outer.Inner', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..a<$core.int>(1, _omitFieldNames ? '' : 'z', $pb.PbFieldType.O3)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Outer_Inner_ clone() => Outer_Inner_()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Outer_Inner_ copyWith(void Function(Outer_Inner_) updates) => super.copyWith((message) => updates(message as Outer_Inner_)) as Outer_Inner_;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Outer_Inner_ create() => Outer_Inner_._();
  Outer_Inner_ createEmptyInstance() => create();
  static $pb.PbList<Outer_Inner_> createRepeated() => $pb.PbList<Outer_Inner_>();
  @$core.pragma('dart2js:noInline')
  static Outer_Inner_ getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Outer_Inner_>(create);
  static Outer_Inner_? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get z => $_getIZ(0);
  @$pb.TagNumber(1)
  set z($core.int v) { $_setSignedInt32(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasZ() => $_has(0);
  @$pb.TagNumber(1)
  void clearZ() => clearField(1);
}

class Outer extends $pb.GeneratedMessage {
  factory Outer({
    Outer_Inner_? inner,
    Outer_Inner? flat,
    List_? list,
  }) {
    final $result = create();
    if (inner != null) {
      $result.inner = inner;
    }
    if (flat != null) {
      $result.flat = flat;
    }
    if (list != null) {
      $result.list = list;
    }
    return $result;
  }
  Outer._() : super();
  factory Outer.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory Outer.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'Outer', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..aOM<Outer_Inner_>(1, _omitFieldNames ? '' : 'inner', subBuilder: Outer_Inner_.create)
    ..aOM<Outer_Inner>(2, _omitFieldNames ? '' : 'flat', subBuilder: Outer_Inner.create)
    ..aOM<List_>(3, _omitFieldNames ? '' : 'list', subBuilder: List_.create)
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  Outer clone() => Outer()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  Outer copyWith(void Function(Outer) updates) => super.copyWith((message) => updates(message as Outer)) as Outer;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Outer create() => Outer._();
  Outer createEmptyInstance() => create();
  static $pb.PbList<Outer> createRepeated() => $pb.PbList<Outer>();
  @$core.pragma('dart2js:noInline')
  static Outer getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Outer>(create);
  static Outer? _defaultInstance;

  @$pb.TagNumber(1)
  Outer_Inner_ get inner => $_getN(0);
  @$pb.TagNumber(1)
  set inner(Outer_Inner_ v) { setField(1, v); }
  @$pb.TagNumber(1)
  $core.bool hasInner() => $_has(0);
  @$pb.TagNumber(1)
  void clearInner() => clearField(1);
  @$pb.TagNumber(1)
  Outer_Inner_ ensureInner() => $_ensure(0);

  @$pb.TagNumber(2)
  Outer_Inner get flat => $_getN(1);
  @$pb.TagNumber(2)
  set flat(Outer_Inner v) { setField(2, v); }
  @$pb.TagNumber(2)
  $core.bool hasFlat() => $_has(1);
  @$pb.TagNumber(2)
  void clearFlat() => clearField(2);
  @$pb.TagNumber(2)
  Outer_Inner ensureFlat() => $_ensure(1);

  @$pb.TagNumber(3)
  List_ get list => $_getN(2);
  @$pb.TagNumber(3)
  set list(List_ v) { setField(3, v); }
  @$pb.TagNumber(3)
  $core.bool hasList() => $_has(2);
  @$pb.TagNumber(3)
  void clearList() => clearField(3);
  @$pb.TagNumber(3)
  List_ ensureList() => $_ensure(2);
}

class GetOrderRequest extends $pb.GeneratedMessage {
  factory GetOrderRequest({
    $core.String? orderId,
  }) {
    final $result = create();
    if (orderId != null) {
      $result.orderId = orderId;
    }
    return $result;
  }
  GetOrderRequest._() : super();
  factory GetOrderRequest.fromBuffer($core.List<$core.int> i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromBuffer(i, r);
  factory GetOrderRequest.fromJson($core.String i, [$pb.ExtensionRegistry r = $pb.ExtensionRegistry.EMPTY]) => create()..mergeFromJson(i, r);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(_omitMessageNames ? '' : 'GetOrderRequest', package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'), createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'orderId')
    ..hasRequiredFields = false
  ;

  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.deepCopy] instead. '
  'Will be removed in next major version')
  GetOrderRequest clone() => GetOrderRequest()..mergeFromMessage(this);
  @$core.Deprecated(
  'Using this can add significant overhead to your binary. '
  'Use [GeneratedMessageGenericExtensions.rebuild] instead. '
  'Will be removed in next major version')
  GetOrderRequest copyWith(void Function(GetOrderRequest) updates) => super.copyWith((message) => updates(message as GetOrderRequest)) as GetOrderRequest;

  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static GetOrderRequest create() => GetOrderRequest._();
  GetOrderRequest createEmptyInstance() => create();
  static $pb.PbList<GetOrderRequest> createRepeated() => $pb.PbList<GetOrderRequest>();
  @$core.pragma('dart2js:noInline')
  static GetOrderRequest getDefault() => _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<GetOrderRequest>(create);
  static GetOrderRequest? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get orderId => $_getSZ(0);
  @$pb.TagNumber(1)
  set orderId($core.String v) { $_setString(0, v); }
  @$pb.TagNumber(1)
  $core.bool hasOrderId() => $_has(0);
  @$pb.TagNumber(1)
  void clearOrderId() => clearField(1);
}


const _omitFieldNames = $core.bool.fromEnvironment('protobuf.omit_field_names');
const _omitMessageNames = $core.bool.fromEnvironment('protobuf.omit_message_names');
