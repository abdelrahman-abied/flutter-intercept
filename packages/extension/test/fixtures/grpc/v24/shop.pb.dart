// This is a generated file - do not edit.
//
// Generated from shop.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names

import 'dart:core' as $core;

import 'package:fixnum/fixnum.dart' as $fixnum;
import 'package:protobuf/protobuf.dart' as $pb;

import 'common.pb.dart' as $2;
import 'google/protobuf/any.pb.dart' as $8;
import 'google/protobuf/duration.pb.dart' as $4;
import 'google/protobuf/field_mask.pb.dart' as $7;
import 'google/protobuf/struct.pb.dart' as $6;
import 'google/protobuf/timestamp.pb.dart' as $3;
import 'google/protobuf/wrappers.pb.dart' as $5;
import 'shop.pbenum.dart';

export 'package:protobuf/protobuf.dart' show GeneratedMessageGenericExtensions;

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
    final result = create();
    if (d != null) result.d = d;
    if (f != null) result.f = f;
    if (i32 != null) result.i32 = i32;
    if (i64 != null) result.i64 = i64;
    if (u32 != null) result.u32 = u32;
    if (u64 != null) result.u64 = u64;
    if (s32 != null) result.s32 = s32;
    if (s64 != null) result.s64 = s64;
    if (fx32 != null) result.fx32 = fx32;
    if (fx64 != null) result.fx64 = fx64;
    if (sfx32 != null) result.sfx32 = sfx32;
    if (sfx64 != null) result.sfx64 = sfx64;
    if (b != null) result.b = b;
    if (s != null) result.s = s;
    if (by != null) result.by = by;
    if (optI32 != null) result.optI32 = optI32;
    if (optS != null) result.optS = optS;
    if (color != null) result.color = color;
    return result;
  }

  Scalars._();

  factory Scalars.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Scalars.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Scalars',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aD(1, _omitFieldNames ? '' : 'd')
    ..aD(2, _omitFieldNames ? '' : 'f', fieldType: $pb.PbFieldType.OF)
    ..aI(3, _omitFieldNames ? '' : 'i32')
    ..aInt64(4, _omitFieldNames ? '' : 'i64')
    ..aI(5, _omitFieldNames ? '' : 'u32', fieldType: $pb.PbFieldType.OU3)
    ..a<$fixnum.Int64>(6, _omitFieldNames ? '' : 'u64', $pb.PbFieldType.OU6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..aI(7, _omitFieldNames ? '' : 's32', fieldType: $pb.PbFieldType.OS3)
    ..a<$fixnum.Int64>(8, _omitFieldNames ? '' : 's64', $pb.PbFieldType.OS6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..aI(9, _omitFieldNames ? '' : 'fx32', fieldType: $pb.PbFieldType.OF3)
    ..a<$fixnum.Int64>(10, _omitFieldNames ? '' : 'fx64', $pb.PbFieldType.OF6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..aI(11, _omitFieldNames ? '' : 'sfx32', fieldType: $pb.PbFieldType.OSF3)
    ..a<$fixnum.Int64>(12, _omitFieldNames ? '' : 'sfx64', $pb.PbFieldType.OSF6,
        defaultOrMaker: $fixnum.Int64.ZERO)
    ..aOB(13, _omitFieldNames ? '' : 'b')
    ..aOS(14, _omitFieldNames ? '' : 's')
    ..a<$core.List<$core.int>>(
        15, _omitFieldNames ? '' : 'by', $pb.PbFieldType.OY)
    ..aI(16, _omitFieldNames ? '' : 'optI32')
    ..aOS(17, _omitFieldNames ? '' : 'optS')
    ..aE<Color>(18, _omitFieldNames ? '' : 'color', enumValues: Color.values)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Scalars clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Scalars copyWith(void Function(Scalars) updates) =>
      super.copyWith((message) => updates(message as Scalars)) as Scalars;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Scalars create() => Scalars._();
  @$core.override
  Scalars createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Scalars getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Scalars>(create);
  static Scalars? _defaultInstance;

  @$pb.TagNumber(1)
  $core.double get d => $_getN(0);
  @$pb.TagNumber(1)
  set d($core.double value) => $_setDouble(0, value);
  @$pb.TagNumber(1)
  $core.bool hasD() => $_has(0);
  @$pb.TagNumber(1)
  void clearD() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.double get f => $_getN(1);
  @$pb.TagNumber(2)
  set f($core.double value) => $_setFloat(1, value);
  @$pb.TagNumber(2)
  $core.bool hasF() => $_has(1);
  @$pb.TagNumber(2)
  void clearF() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.int get i32 => $_getIZ(2);
  @$pb.TagNumber(3)
  set i32($core.int value) => $_setSignedInt32(2, value);
  @$pb.TagNumber(3)
  $core.bool hasI32() => $_has(2);
  @$pb.TagNumber(3)
  void clearI32() => $_clearField(3);

  @$pb.TagNumber(4)
  $fixnum.Int64 get i64 => $_getI64(3);
  @$pb.TagNumber(4)
  set i64($fixnum.Int64 value) => $_setInt64(3, value);
  @$pb.TagNumber(4)
  $core.bool hasI64() => $_has(3);
  @$pb.TagNumber(4)
  void clearI64() => $_clearField(4);

  @$pb.TagNumber(5)
  $core.int get u32 => $_getIZ(4);
  @$pb.TagNumber(5)
  set u32($core.int value) => $_setUnsignedInt32(4, value);
  @$pb.TagNumber(5)
  $core.bool hasU32() => $_has(4);
  @$pb.TagNumber(5)
  void clearU32() => $_clearField(5);

  @$pb.TagNumber(6)
  $fixnum.Int64 get u64 => $_getI64(5);
  @$pb.TagNumber(6)
  set u64($fixnum.Int64 value) => $_setInt64(5, value);
  @$pb.TagNumber(6)
  $core.bool hasU64() => $_has(5);
  @$pb.TagNumber(6)
  void clearU64() => $_clearField(6);

  @$pb.TagNumber(7)
  $core.int get s32 => $_getIZ(6);
  @$pb.TagNumber(7)
  set s32($core.int value) => $_setSignedInt32(6, value);
  @$pb.TagNumber(7)
  $core.bool hasS32() => $_has(6);
  @$pb.TagNumber(7)
  void clearS32() => $_clearField(7);

  @$pb.TagNumber(8)
  $fixnum.Int64 get s64 => $_getI64(7);
  @$pb.TagNumber(8)
  set s64($fixnum.Int64 value) => $_setInt64(7, value);
  @$pb.TagNumber(8)
  $core.bool hasS64() => $_has(7);
  @$pb.TagNumber(8)
  void clearS64() => $_clearField(8);

  @$pb.TagNumber(9)
  $core.int get fx32 => $_getIZ(8);
  @$pb.TagNumber(9)
  set fx32($core.int value) => $_setUnsignedInt32(8, value);
  @$pb.TagNumber(9)
  $core.bool hasFx32() => $_has(8);
  @$pb.TagNumber(9)
  void clearFx32() => $_clearField(9);

  @$pb.TagNumber(10)
  $fixnum.Int64 get fx64 => $_getI64(9);
  @$pb.TagNumber(10)
  set fx64($fixnum.Int64 value) => $_setInt64(9, value);
  @$pb.TagNumber(10)
  $core.bool hasFx64() => $_has(9);
  @$pb.TagNumber(10)
  void clearFx64() => $_clearField(10);

  @$pb.TagNumber(11)
  $core.int get sfx32 => $_getIZ(10);
  @$pb.TagNumber(11)
  set sfx32($core.int value) => $_setSignedInt32(10, value);
  @$pb.TagNumber(11)
  $core.bool hasSfx32() => $_has(10);
  @$pb.TagNumber(11)
  void clearSfx32() => $_clearField(11);

  @$pb.TagNumber(12)
  $fixnum.Int64 get sfx64 => $_getI64(11);
  @$pb.TagNumber(12)
  set sfx64($fixnum.Int64 value) => $_setInt64(11, value);
  @$pb.TagNumber(12)
  $core.bool hasSfx64() => $_has(11);
  @$pb.TagNumber(12)
  void clearSfx64() => $_clearField(12);

  @$pb.TagNumber(13)
  $core.bool get b => $_getBF(12);
  @$pb.TagNumber(13)
  set b($core.bool value) => $_setBool(12, value);
  @$pb.TagNumber(13)
  $core.bool hasB() => $_has(12);
  @$pb.TagNumber(13)
  void clearB() => $_clearField(13);

  @$pb.TagNumber(14)
  $core.String get s => $_getSZ(13);
  @$pb.TagNumber(14)
  set s($core.String value) => $_setString(13, value);
  @$pb.TagNumber(14)
  $core.bool hasS() => $_has(13);
  @$pb.TagNumber(14)
  void clearS() => $_clearField(14);

  @$pb.TagNumber(15)
  $core.List<$core.int> get by => $_getN(14);
  @$pb.TagNumber(15)
  set by($core.List<$core.int> value) => $_setBytes(14, value);
  @$pb.TagNumber(15)
  $core.bool hasBy() => $_has(14);
  @$pb.TagNumber(15)
  void clearBy() => $_clearField(15);

  @$pb.TagNumber(16)
  $core.int get optI32 => $_getIZ(15);
  @$pb.TagNumber(16)
  set optI32($core.int value) => $_setSignedInt32(15, value);
  @$pb.TagNumber(16)
  $core.bool hasOptI32() => $_has(15);
  @$pb.TagNumber(16)
  void clearOptI32() => $_clearField(16);

  @$pb.TagNumber(17)
  $core.String get optS => $_getSZ(16);
  @$pb.TagNumber(17)
  set optS($core.String value) => $_setString(16, value);
  @$pb.TagNumber(17)
  $core.bool hasOptS() => $_has(16);
  @$pb.TagNumber(17)
  void clearOptS() => $_clearField(17);

  @$pb.TagNumber(18)
  Color get color => $_getN(17);
  @$pb.TagNumber(18)
  set color(Color value) => $_setField(18, value);
  @$pb.TagNumber(18)
  $core.bool hasColor() => $_has(17);
  @$pb.TagNumber(18)
  void clearColor() => $_clearField(18);
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
    $core.Iterable<$2.Money>? moneys,
    $core.Iterable<$core.int>? unpacked,
  }) {
    final result = create();
    if (d != null) result.d.addAll(d);
    if (f != null) result.f.addAll(f);
    if (i32 != null) result.i32.addAll(i32);
    if (i64 != null) result.i64.addAll(i64);
    if (u32 != null) result.u32.addAll(u32);
    if (u64 != null) result.u64.addAll(u64);
    if (s32 != null) result.s32.addAll(s32);
    if (s64 != null) result.s64.addAll(s64);
    if (fx32 != null) result.fx32.addAll(fx32);
    if (fx64 != null) result.fx64.addAll(fx64);
    if (sfx32 != null) result.sfx32.addAll(sfx32);
    if (sfx64 != null) result.sfx64.addAll(sfx64);
    if (b != null) result.b.addAll(b);
    if (s != null) result.s.addAll(s);
    if (by != null) result.by.addAll(by);
    if (colors != null) result.colors.addAll(colors);
    if (moneys != null) result.moneys.addAll(moneys);
    if (unpacked != null) result.unpacked.addAll(unpacked);
    return result;
  }

  Repeats._();

  factory Repeats.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Repeats.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Repeats',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
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
    ..p<$core.List<$core.int>>(
        15, _omitFieldNames ? '' : 'by', $pb.PbFieldType.PY)
    ..pc<Color>(16, _omitFieldNames ? '' : 'colors', $pb.PbFieldType.KE,
        valueOf: Color.valueOf,
        enumValues: Color.values,
        defaultEnumValue: Color.COLOR_UNSPECIFIED)
    ..pPM<$2.Money>(17, _omitFieldNames ? '' : 'moneys',
        subBuilder: $2.Money.create)
    ..p<$core.int>(18, _omitFieldNames ? '' : 'unpacked', $pb.PbFieldType.P3)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Repeats clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Repeats copyWith(void Function(Repeats) updates) =>
      super.copyWith((message) => updates(message as Repeats)) as Repeats;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Repeats create() => Repeats._();
  @$core.override
  Repeats createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Repeats getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Repeats>(create);
  static Repeats? _defaultInstance;

  @$pb.TagNumber(1)
  $pb.PbList<$core.double> get d => $_getList(0);

  @$pb.TagNumber(2)
  $pb.PbList<$core.double> get f => $_getList(1);

  @$pb.TagNumber(3)
  $pb.PbList<$core.int> get i32 => $_getList(2);

  @$pb.TagNumber(4)
  $pb.PbList<$fixnum.Int64> get i64 => $_getList(3);

  @$pb.TagNumber(5)
  $pb.PbList<$core.int> get u32 => $_getList(4);

  @$pb.TagNumber(6)
  $pb.PbList<$fixnum.Int64> get u64 => $_getList(5);

  @$pb.TagNumber(7)
  $pb.PbList<$core.int> get s32 => $_getList(6);

  @$pb.TagNumber(8)
  $pb.PbList<$fixnum.Int64> get s64 => $_getList(7);

  @$pb.TagNumber(9)
  $pb.PbList<$core.int> get fx32 => $_getList(8);

  @$pb.TagNumber(10)
  $pb.PbList<$fixnum.Int64> get fx64 => $_getList(9);

  @$pb.TagNumber(11)
  $pb.PbList<$core.int> get sfx32 => $_getList(10);

  @$pb.TagNumber(12)
  $pb.PbList<$fixnum.Int64> get sfx64 => $_getList(11);

  @$pb.TagNumber(13)
  $pb.PbList<$core.bool> get b => $_getList(12);

  @$pb.TagNumber(14)
  $pb.PbList<$core.String> get s => $_getList(13);

  @$pb.TagNumber(15)
  $pb.PbList<$core.List<$core.int>> get by => $_getList(14);

  @$pb.TagNumber(16)
  $pb.PbList<Color> get colors => $_getList(15);

  @$pb.TagNumber(17)
  $pb.PbList<$2.Money> get moneys => $_getList(16);

  @$pb.TagNumber(18)
  $pb.PbList<$core.int> get unpacked => $_getList(17);
}

class Order_Line_Note extends $pb.GeneratedMessage {
  factory Order_Line_Note({
    $core.String? text,
  }) {
    final result = create();
    if (text != null) result.text = text;
    return result;
  }

  Order_Line_Note._();

  factory Order_Line_Note.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Order_Line_Note.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Order.Line.Note',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'text')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order_Line_Note clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order_Line_Note copyWith(void Function(Order_Line_Note) updates) =>
      super.copyWith((message) => updates(message as Order_Line_Note))
          as Order_Line_Note;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Order_Line_Note create() => Order_Line_Note._();
  @$core.override
  Order_Line_Note createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Order_Line_Note getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Order_Line_Note>(create);
  static Order_Line_Note? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get text => $_getSZ(0);
  @$pb.TagNumber(1)
  set text($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasText() => $_has(0);
  @$pb.TagNumber(1)
  void clearText() => $_clearField(1);
}

class Order_Line extends $pb.GeneratedMessage {
  factory Order_Line({
    $core.String? sku,
    $core.int? qty,
    $2.Money? price,
    Order_Line_Kind? kind,
    $core.Iterable<Order_Line_Note>? notes,
  }) {
    final result = create();
    if (sku != null) result.sku = sku;
    if (qty != null) result.qty = qty;
    if (price != null) result.price = price;
    if (kind != null) result.kind = kind;
    if (notes != null) result.notes.addAll(notes);
    return result;
  }

  Order_Line._();

  factory Order_Line.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Order_Line.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Order.Line',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'sku')
    ..aI(2, _omitFieldNames ? '' : 'qty')
    ..aOM<$2.Money>(3, _omitFieldNames ? '' : 'price',
        subBuilder: $2.Money.create)
    ..aE<Order_Line_Kind>(4, _omitFieldNames ? '' : 'kind',
        enumValues: Order_Line_Kind.values)
    ..pPM<Order_Line_Note>(5, _omitFieldNames ? '' : 'notes',
        subBuilder: Order_Line_Note.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order_Line clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order_Line copyWith(void Function(Order_Line) updates) =>
      super.copyWith((message) => updates(message as Order_Line)) as Order_Line;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Order_Line create() => Order_Line._();
  @$core.override
  Order_Line createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Order_Line getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Order_Line>(create);
  static Order_Line? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get sku => $_getSZ(0);
  @$pb.TagNumber(1)
  set sku($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasSku() => $_has(0);
  @$pb.TagNumber(1)
  void clearSku() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.int get qty => $_getIZ(1);
  @$pb.TagNumber(2)
  set qty($core.int value) => $_setSignedInt32(1, value);
  @$pb.TagNumber(2)
  $core.bool hasQty() => $_has(1);
  @$pb.TagNumber(2)
  void clearQty() => $_clearField(2);

  @$pb.TagNumber(3)
  $2.Money get price => $_getN(2);
  @$pb.TagNumber(3)
  set price($2.Money value) => $_setField(3, value);
  @$pb.TagNumber(3)
  $core.bool hasPrice() => $_has(2);
  @$pb.TagNumber(3)
  void clearPrice() => $_clearField(3);
  @$pb.TagNumber(3)
  $2.Money ensurePrice() => $_ensure(2);

  @$pb.TagNumber(4)
  Order_Line_Kind get kind => $_getN(3);
  @$pb.TagNumber(4)
  set kind(Order_Line_Kind value) => $_setField(4, value);
  @$pb.TagNumber(4)
  $core.bool hasKind() => $_has(3);
  @$pb.TagNumber(4)
  void clearKind() => $_clearField(4);

  @$pb.TagNumber(5)
  $pb.PbList<Order_Line_Note> get notes => $_getList(4);
}

enum Order_Payment { cardToken, cash, invoice, notSet }

class Order extends $pb.GeneratedMessage {
  factory Order({
    $core.String? orderId,
    $core.Iterable<Order_Line>? lines,
    $core.Iterable<$core.MapEntry<$core.String, $core.String>>? labels,
    $core.Iterable<$core.MapEntry<$core.int, Order_Line>>? linesByNo,
    $core.Iterable<$core.MapEntry<$core.String, Color>>? colorsByName,
    $core.Iterable<$core.MapEntry<$fixnum.Int64, $core.bool>>? flags,
    $core.Iterable<$core.MapEntry<$core.bool, $core.List<$core.int>>>? blobs,
    $core.Iterable<$core.MapEntry<$fixnum.Int64, $2.Level>>? levels,
    $core.String? cardToken,
    $2.Money? cash,
    $core.bool? invoice,
    $3.Timestamp? createdAt,
    $4.Duration? ttl,
    $5.StringValue? note,
    $5.Int64Value? big,
    $6.Struct? meta,
    $6.Value? anyValue,
    $7.FieldMask? mask,
    $8.Any? extra,
    $5.BoolValue? gift,
    Order? parent,
    $2.Level? level,
    $core.String? class_31,
    $core.String? custom,
    $6.ListValue? listValue,
    $5.BytesValue? rawValue,
  }) {
    final result = create();
    if (orderId != null) result.orderId = orderId;
    if (lines != null) result.lines.addAll(lines);
    if (labels != null) result.labels.addEntries(labels);
    if (linesByNo != null) result.linesByNo.addEntries(linesByNo);
    if (colorsByName != null) result.colorsByName.addEntries(colorsByName);
    if (flags != null) result.flags.addEntries(flags);
    if (blobs != null) result.blobs.addEntries(blobs);
    if (levels != null) result.levels.addEntries(levels);
    if (cardToken != null) result.cardToken = cardToken;
    if (cash != null) result.cash = cash;
    if (invoice != null) result.invoice = invoice;
    if (createdAt != null) result.createdAt = createdAt;
    if (ttl != null) result.ttl = ttl;
    if (note != null) result.note = note;
    if (big != null) result.big = big;
    if (meta != null) result.meta = meta;
    if (anyValue != null) result.anyValue = anyValue;
    if (mask != null) result.mask = mask;
    if (extra != null) result.extra = extra;
    if (gift != null) result.gift = gift;
    if (parent != null) result.parent = parent;
    if (level != null) result.level = level;
    if (class_31 != null) result.class_31 = class_31;
    if (custom != null) result.custom = custom;
    if (listValue != null) result.listValue = listValue;
    if (rawValue != null) result.rawValue = rawValue;
    return result;
  }

  Order._();

  factory Order.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Order.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static const $core.Map<$core.int, Order_Payment> _Order_PaymentByTag = {
    10: Order_Payment.cardToken,
    11: Order_Payment.cash,
    12: Order_Payment.invoice,
    0: Order_Payment.notSet
  };
  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Order',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..oo(0, [10, 11, 12])
    ..aOS(1, _omitFieldNames ? '' : 'orderId')
    ..pPM<Order_Line>(2, _omitFieldNames ? '' : 'lines',
        subBuilder: Order_Line.create)
    ..m<$core.String, $core.String>(3, _omitFieldNames ? '' : 'labels',
        entryClassName: 'Order.LabelsEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$core.int, Order_Line>(4, _omitFieldNames ? '' : 'linesByNo',
        entryClassName: 'Order.LinesByNoEntry',
        keyFieldType: $pb.PbFieldType.O3,
        valueFieldType: $pb.PbFieldType.OM,
        valueCreator: Order_Line.create,
        valueDefaultOrMaker: Order_Line.getDefault,
        packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$core.String, Color>(5, _omitFieldNames ? '' : 'colorsByName',
        entryClassName: 'Order.ColorsByNameEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OE,
        valueOf: Color.valueOf,
        enumValues: Color.values,
        valueDefaultOrMaker: Color.COLOR_UNSPECIFIED,
        defaultEnumValue: Color.COLOR_UNSPECIFIED,
        packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$fixnum.Int64, $core.bool>(6, _omitFieldNames ? '' : 'flags',
        entryClassName: 'Order.FlagsEntry',
        keyFieldType: $pb.PbFieldType.O6,
        valueFieldType: $pb.PbFieldType.OB,
        packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$core.bool, $core.List<$core.int>>(7, _omitFieldNames ? '' : 'blobs',
        entryClassName: 'Order.BlobsEntry',
        keyFieldType: $pb.PbFieldType.OB,
        valueFieldType: $pb.PbFieldType.OY,
        packageName: const $pb.PackageName('fi.shop.v1'))
    ..m<$fixnum.Int64, $2.Level>(8, _omitFieldNames ? '' : 'levels',
        entryClassName: 'Order.LevelsEntry',
        keyFieldType: $pb.PbFieldType.OU6,
        valueFieldType: $pb.PbFieldType.OE,
        valueOf: $2.Level.valueOf,
        enumValues: $2.Level.values,
        valueDefaultOrMaker: $2.Level.LEVEL_UNSPECIFIED,
        defaultEnumValue: $2.Level.LEVEL_UNSPECIFIED,
        packageName: const $pb.PackageName('fi.shop.v1'))
    ..aOS(10, _omitFieldNames ? '' : 'cardToken')
    ..aOM<$2.Money>(11, _omitFieldNames ? '' : 'cash',
        subBuilder: $2.Money.create)
    ..aOB(12, _omitFieldNames ? '' : 'invoice')
    ..aOM<$3.Timestamp>(20, _omitFieldNames ? '' : 'createdAt',
        subBuilder: $3.Timestamp.create)
    ..aOM<$4.Duration>(21, _omitFieldNames ? '' : 'ttl',
        subBuilder: $4.Duration.create)
    ..aOM<$5.StringValue>(22, _omitFieldNames ? '' : 'note',
        subBuilder: $5.StringValue.create)
    ..aOM<$5.Int64Value>(23, _omitFieldNames ? '' : 'big',
        subBuilder: $5.Int64Value.create)
    ..aOM<$6.Struct>(24, _omitFieldNames ? '' : 'meta',
        subBuilder: $6.Struct.create)
    ..aOM<$6.Value>(25, _omitFieldNames ? '' : 'anyValue',
        subBuilder: $6.Value.create)
    ..aOM<$7.FieldMask>(26, _omitFieldNames ? '' : 'mask',
        subBuilder: $7.FieldMask.create)
    ..aOM<$8.Any>(27, _omitFieldNames ? '' : 'extra', subBuilder: $8.Any.create)
    ..aOM<$5.BoolValue>(28, _omitFieldNames ? '' : 'gift',
        subBuilder: $5.BoolValue.create)
    ..aOM<Order>(29, _omitFieldNames ? '' : 'parent', subBuilder: Order.create)
    ..aE<$2.Level>(30, _omitFieldNames ? '' : 'level',
        enumValues: $2.Level.values)
    ..aOS(31, _omitFieldNames ? '' : 'class')
    ..aOS(32, _omitFieldNames ? '' : 'customJson', protoName: 'custom')
    ..aOM<$6.ListValue>(33, _omitFieldNames ? '' : 'listValue',
        subBuilder: $6.ListValue.create)
    ..aOM<$5.BytesValue>(34, _omitFieldNames ? '' : 'rawValue',
        subBuilder: $5.BytesValue.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order copyWith(void Function(Order) updates) =>
      super.copyWith((message) => updates(message as Order)) as Order;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Order create() => Order._();
  @$core.override
  Order createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Order getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Order>(create);
  static Order? _defaultInstance;

  @$pb.TagNumber(10)
  @$pb.TagNumber(11)
  @$pb.TagNumber(12)
  Order_Payment whichPayment() => _Order_PaymentByTag[$_whichOneof(0)]!;
  @$pb.TagNumber(10)
  @$pb.TagNumber(11)
  @$pb.TagNumber(12)
  void clearPayment() => $_clearField($_whichOneof(0));

  @$pb.TagNumber(1)
  $core.String get orderId => $_getSZ(0);
  @$pb.TagNumber(1)
  set orderId($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasOrderId() => $_has(0);
  @$pb.TagNumber(1)
  void clearOrderId() => $_clearField(1);

  @$pb.TagNumber(2)
  $pb.PbList<Order_Line> get lines => $_getList(1);

  @$pb.TagNumber(3)
  $pb.PbMap<$core.String, $core.String> get labels => $_getMap(2);

  @$pb.TagNumber(4)
  $pb.PbMap<$core.int, Order_Line> get linesByNo => $_getMap(3);

  @$pb.TagNumber(5)
  $pb.PbMap<$core.String, Color> get colorsByName => $_getMap(4);

  @$pb.TagNumber(6)
  $pb.PbMap<$fixnum.Int64, $core.bool> get flags => $_getMap(5);

  @$pb.TagNumber(7)
  $pb.PbMap<$core.bool, $core.List<$core.int>> get blobs => $_getMap(6);

  @$pb.TagNumber(8)
  $pb.PbMap<$fixnum.Int64, $2.Level> get levels => $_getMap(7);

  @$pb.TagNumber(10)
  $core.String get cardToken => $_getSZ(8);
  @$pb.TagNumber(10)
  set cardToken($core.String value) => $_setString(8, value);
  @$pb.TagNumber(10)
  $core.bool hasCardToken() => $_has(8);
  @$pb.TagNumber(10)
  void clearCardToken() => $_clearField(10);

  @$pb.TagNumber(11)
  $2.Money get cash => $_getN(9);
  @$pb.TagNumber(11)
  set cash($2.Money value) => $_setField(11, value);
  @$pb.TagNumber(11)
  $core.bool hasCash() => $_has(9);
  @$pb.TagNumber(11)
  void clearCash() => $_clearField(11);
  @$pb.TagNumber(11)
  $2.Money ensureCash() => $_ensure(9);

  @$pb.TagNumber(12)
  $core.bool get invoice => $_getBF(10);
  @$pb.TagNumber(12)
  set invoice($core.bool value) => $_setBool(10, value);
  @$pb.TagNumber(12)
  $core.bool hasInvoice() => $_has(10);
  @$pb.TagNumber(12)
  void clearInvoice() => $_clearField(12);

  @$pb.TagNumber(20)
  $3.Timestamp get createdAt => $_getN(11);
  @$pb.TagNumber(20)
  set createdAt($3.Timestamp value) => $_setField(20, value);
  @$pb.TagNumber(20)
  $core.bool hasCreatedAt() => $_has(11);
  @$pb.TagNumber(20)
  void clearCreatedAt() => $_clearField(20);
  @$pb.TagNumber(20)
  $3.Timestamp ensureCreatedAt() => $_ensure(11);

  @$pb.TagNumber(21)
  $4.Duration get ttl => $_getN(12);
  @$pb.TagNumber(21)
  set ttl($4.Duration value) => $_setField(21, value);
  @$pb.TagNumber(21)
  $core.bool hasTtl() => $_has(12);
  @$pb.TagNumber(21)
  void clearTtl() => $_clearField(21);
  @$pb.TagNumber(21)
  $4.Duration ensureTtl() => $_ensure(12);

  @$pb.TagNumber(22)
  $5.StringValue get note => $_getN(13);
  @$pb.TagNumber(22)
  set note($5.StringValue value) => $_setField(22, value);
  @$pb.TagNumber(22)
  $core.bool hasNote() => $_has(13);
  @$pb.TagNumber(22)
  void clearNote() => $_clearField(22);
  @$pb.TagNumber(22)
  $5.StringValue ensureNote() => $_ensure(13);

  @$pb.TagNumber(23)
  $5.Int64Value get big => $_getN(14);
  @$pb.TagNumber(23)
  set big($5.Int64Value value) => $_setField(23, value);
  @$pb.TagNumber(23)
  $core.bool hasBig() => $_has(14);
  @$pb.TagNumber(23)
  void clearBig() => $_clearField(23);
  @$pb.TagNumber(23)
  $5.Int64Value ensureBig() => $_ensure(14);

  @$pb.TagNumber(24)
  $6.Struct get meta => $_getN(15);
  @$pb.TagNumber(24)
  set meta($6.Struct value) => $_setField(24, value);
  @$pb.TagNumber(24)
  $core.bool hasMeta() => $_has(15);
  @$pb.TagNumber(24)
  void clearMeta() => $_clearField(24);
  @$pb.TagNumber(24)
  $6.Struct ensureMeta() => $_ensure(15);

  @$pb.TagNumber(25)
  $6.Value get anyValue => $_getN(16);
  @$pb.TagNumber(25)
  set anyValue($6.Value value) => $_setField(25, value);
  @$pb.TagNumber(25)
  $core.bool hasAnyValue() => $_has(16);
  @$pb.TagNumber(25)
  void clearAnyValue() => $_clearField(25);
  @$pb.TagNumber(25)
  $6.Value ensureAnyValue() => $_ensure(16);

  @$pb.TagNumber(26)
  $7.FieldMask get mask => $_getN(17);
  @$pb.TagNumber(26)
  set mask($7.FieldMask value) => $_setField(26, value);
  @$pb.TagNumber(26)
  $core.bool hasMask() => $_has(17);
  @$pb.TagNumber(26)
  void clearMask() => $_clearField(26);
  @$pb.TagNumber(26)
  $7.FieldMask ensureMask() => $_ensure(17);

  @$pb.TagNumber(27)
  $8.Any get extra => $_getN(18);
  @$pb.TagNumber(27)
  set extra($8.Any value) => $_setField(27, value);
  @$pb.TagNumber(27)
  $core.bool hasExtra() => $_has(18);
  @$pb.TagNumber(27)
  void clearExtra() => $_clearField(27);
  @$pb.TagNumber(27)
  $8.Any ensureExtra() => $_ensure(18);

  @$pb.TagNumber(28)
  $5.BoolValue get gift => $_getN(19);
  @$pb.TagNumber(28)
  set gift($5.BoolValue value) => $_setField(28, value);
  @$pb.TagNumber(28)
  $core.bool hasGift() => $_has(19);
  @$pb.TagNumber(28)
  void clearGift() => $_clearField(28);
  @$pb.TagNumber(28)
  $5.BoolValue ensureGift() => $_ensure(19);

  @$pb.TagNumber(29)
  Order get parent => $_getN(20);
  @$pb.TagNumber(29)
  set parent(Order value) => $_setField(29, value);
  @$pb.TagNumber(29)
  $core.bool hasParent() => $_has(20);
  @$pb.TagNumber(29)
  void clearParent() => $_clearField(29);
  @$pb.TagNumber(29)
  Order ensureParent() => $_ensure(20);

  @$pb.TagNumber(30)
  $2.Level get level => $_getN(21);
  @$pb.TagNumber(30)
  set level($2.Level value) => $_setField(30, value);
  @$pb.TagNumber(30)
  $core.bool hasLevel() => $_has(21);
  @$pb.TagNumber(30)
  void clearLevel() => $_clearField(30);

  @$pb.TagNumber(31)
  $core.String get class_31 => $_getSZ(22);
  @$pb.TagNumber(31)
  set class_31($core.String value) => $_setString(22, value);
  @$pb.TagNumber(31)
  $core.bool hasClass_31() => $_has(22);
  @$pb.TagNumber(31)
  void clearClass_31() => $_clearField(31);

  @$pb.TagNumber(32)
  $core.String get custom => $_getSZ(23);
  @$pb.TagNumber(32)
  set custom($core.String value) => $_setString(23, value);
  @$pb.TagNumber(32)
  $core.bool hasCustom() => $_has(23);
  @$pb.TagNumber(32)
  void clearCustom() => $_clearField(32);

  @$pb.TagNumber(33)
  $6.ListValue get listValue => $_getN(24);
  @$pb.TagNumber(33)
  set listValue($6.ListValue value) => $_setField(33, value);
  @$pb.TagNumber(33)
  $core.bool hasListValue() => $_has(24);
  @$pb.TagNumber(33)
  void clearListValue() => $_clearField(33);
  @$pb.TagNumber(33)
  $6.ListValue ensureListValue() => $_ensure(24);

  @$pb.TagNumber(34)
  $5.BytesValue get rawValue => $_getN(25);
  @$pb.TagNumber(34)
  set rawValue($5.BytesValue value) => $_setField(34, value);
  @$pb.TagNumber(34)
  $core.bool hasRawValue() => $_has(25);
  @$pb.TagNumber(34)
  void clearRawValue() => $_clearField(34);
  @$pb.TagNumber(34)
  $5.BytesValue ensureRawValue() => $_ensure(25);
}

/// A message whose name clashes with a Dart core type.
class List_ extends $pb.GeneratedMessage {
  factory List_({
    $core.int? x,
  }) {
    final result = create();
    if (x != null) result.x = x;
    return result;
  }

  List_._();

  factory List_.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory List_.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'List',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aI(1, _omitFieldNames ? '' : 'x')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  List_ clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  List_ copyWith(void Function(List_) updates) =>
      super.copyWith((message) => updates(message as List_)) as List_;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static List_ create() => List_._();
  @$core.override
  List_ createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static List_ getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<List_>(create);
  static List_? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get x => $_getIZ(0);
  @$pb.TagNumber(1)
  set x($core.int value) => $_setSignedInt32(0, value);
  @$pb.TagNumber(1)
  $core.bool hasX() => $_has(0);
  @$pb.TagNumber(1)
  void clearX() => $_clearField(1);
}

/// A top-level message whose Dart class looks like a nested one.
class Outer_Inner extends $pb.GeneratedMessage {
  factory Outer_Inner({
    $core.int? y,
  }) {
    final result = create();
    if (y != null) result.y = y;
    return result;
  }

  Outer_Inner._();

  factory Outer_Inner.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Outer_Inner.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Outer_Inner',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aI(1, _omitFieldNames ? '' : 'y')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Outer_Inner clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Outer_Inner copyWith(void Function(Outer_Inner) updates) =>
      super.copyWith((message) => updates(message as Outer_Inner))
          as Outer_Inner;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Outer_Inner create() => Outer_Inner._();
  @$core.override
  Outer_Inner createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Outer_Inner getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Outer_Inner>(create);
  static Outer_Inner? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get y => $_getIZ(0);
  @$pb.TagNumber(1)
  set y($core.int value) => $_setSignedInt32(0, value);
  @$pb.TagNumber(1)
  $core.bool hasY() => $_has(0);
  @$pb.TagNumber(1)
  void clearY() => $_clearField(1);
}

class Outer_Inner_ extends $pb.GeneratedMessage {
  factory Outer_Inner_({
    $core.int? z,
  }) {
    final result = create();
    if (z != null) result.z = z;
    return result;
  }

  Outer_Inner_._();

  factory Outer_Inner_.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Outer_Inner_.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Outer.Inner',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aI(1, _omitFieldNames ? '' : 'z')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Outer_Inner_ clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Outer_Inner_ copyWith(void Function(Outer_Inner_) updates) =>
      super.copyWith((message) => updates(message as Outer_Inner_))
          as Outer_Inner_;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Outer_Inner_ create() => Outer_Inner_._();
  @$core.override
  Outer_Inner_ createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Outer_Inner_ getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Outer_Inner_>(create);
  static Outer_Inner_? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get z => $_getIZ(0);
  @$pb.TagNumber(1)
  set z($core.int value) => $_setSignedInt32(0, value);
  @$pb.TagNumber(1)
  $core.bool hasZ() => $_has(0);
  @$pb.TagNumber(1)
  void clearZ() => $_clearField(1);
}

class Outer extends $pb.GeneratedMessage {
  factory Outer({
    Outer_Inner_? inner,
    Outer_Inner? flat,
    List_? list,
  }) {
    final result = create();
    if (inner != null) result.inner = inner;
    if (flat != null) result.flat = flat;
    if (list != null) result.list = list;
    return result;
  }

  Outer._();

  factory Outer.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory Outer.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Outer',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aOM<Outer_Inner_>(1, _omitFieldNames ? '' : 'inner',
        subBuilder: Outer_Inner_.create)
    ..aOM<Outer_Inner>(2, _omitFieldNames ? '' : 'flat',
        subBuilder: Outer_Inner.create)
    ..aOM<List_>(3, _omitFieldNames ? '' : 'list', subBuilder: List_.create)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Outer clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Outer copyWith(void Function(Outer) updates) =>
      super.copyWith((message) => updates(message as Outer)) as Outer;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static Outer create() => Outer._();
  @$core.override
  Outer createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static Outer getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Outer>(create);
  static Outer? _defaultInstance;

  @$pb.TagNumber(1)
  Outer_Inner_ get inner => $_getN(0);
  @$pb.TagNumber(1)
  set inner(Outer_Inner_ value) => $_setField(1, value);
  @$pb.TagNumber(1)
  $core.bool hasInner() => $_has(0);
  @$pb.TagNumber(1)
  void clearInner() => $_clearField(1);
  @$pb.TagNumber(1)
  Outer_Inner_ ensureInner() => $_ensure(0);

  @$pb.TagNumber(2)
  Outer_Inner get flat => $_getN(1);
  @$pb.TagNumber(2)
  set flat(Outer_Inner value) => $_setField(2, value);
  @$pb.TagNumber(2)
  $core.bool hasFlat() => $_has(1);
  @$pb.TagNumber(2)
  void clearFlat() => $_clearField(2);
  @$pb.TagNumber(2)
  Outer_Inner ensureFlat() => $_ensure(1);

  @$pb.TagNumber(3)
  List_ get list => $_getN(2);
  @$pb.TagNumber(3)
  set list(List_ value) => $_setField(3, value);
  @$pb.TagNumber(3)
  $core.bool hasList() => $_has(2);
  @$pb.TagNumber(3)
  void clearList() => $_clearField(3);
  @$pb.TagNumber(3)
  List_ ensureList() => $_ensure(2);
}

class GetOrderRequest extends $pb.GeneratedMessage {
  factory GetOrderRequest({
    $core.String? orderId,
  }) {
    final result = create();
    if (orderId != null) result.orderId = orderId;
    return result;
  }

  GetOrderRequest._();

  factory GetOrderRequest.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromBuffer(data, registry);
  factory GetOrderRequest.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      create()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'GetOrderRequest',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'fi.shop.v1'),
      createEmptyInstance: create)
    ..aOS(1, _omitFieldNames ? '' : 'orderId')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  GetOrderRequest clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  GetOrderRequest copyWith(void Function(GetOrderRequest) updates) =>
      super.copyWith((message) => updates(message as GetOrderRequest))
          as GetOrderRequest;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  static GetOrderRequest create() => GetOrderRequest._();
  @$core.override
  GetOrderRequest createEmptyInstance() => create();
  @$core.pragma('dart2js:noInline')
  static GetOrderRequest getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<GetOrderRequest>(create);
  static GetOrderRequest? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get orderId => $_getSZ(0);
  @$pb.TagNumber(1)
  set orderId($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasOrderId() => $_has(0);
  @$pb.TagNumber(1)
  void clearOrderId() => $_clearField(1);
}

const $core.bool _omitFieldNames =
    $core.bool.fromEnvironment('protobuf.omit_field_names');
const $core.bool _omitMessageNames =
    $core.bool.fromEnvironment('protobuf.omit_message_names');
