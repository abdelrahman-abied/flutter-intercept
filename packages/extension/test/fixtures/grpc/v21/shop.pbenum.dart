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

import 'package:protobuf/protobuf.dart' as $pb;

class Color extends $pb.ProtobufEnum {
  static const Color COLOR_UNSPECIFIED = Color._(0, _omitEnumNames ? '' : 'COLOR_UNSPECIFIED');
  static const Color RED = Color._(1, _omitEnumNames ? '' : 'RED');
  static const Color GREEN = Color._(2, _omitEnumNames ? '' : 'GREEN');
  static const Color BLUE = Color._(3, _omitEnumNames ? '' : 'BLUE');

  static const $core.List<Color> values = <Color> [
    COLOR_UNSPECIFIED,
    RED,
    GREEN,
    BLUE,
  ];

  static final $core.Map<$core.int, Color> _byValue = $pb.ProtobufEnum.initByValue(values);
  static Color? valueOf($core.int value) => _byValue[value];

  const Color._($core.int v, $core.String n) : super(v, n);
}

class Order_Line_Kind extends $pb.ProtobufEnum {
  static const Order_Line_Kind KIND_UNSPECIFIED = Order_Line_Kind._(0, _omitEnumNames ? '' : 'KIND_UNSPECIFIED');
  static const Order_Line_Kind PHYSICAL = Order_Line_Kind._(1, _omitEnumNames ? '' : 'PHYSICAL');
  static const Order_Line_Kind DIGITAL = Order_Line_Kind._(2, _omitEnumNames ? '' : 'DIGITAL');

  static const $core.List<Order_Line_Kind> values = <Order_Line_Kind> [
    KIND_UNSPECIFIED,
    PHYSICAL,
    DIGITAL,
  ];

  static final $core.Map<$core.int, Order_Line_Kind> _byValue = $pb.ProtobufEnum.initByValue(values);
  static Order_Line_Kind? valueOf($core.int value) => _byValue[value];

  const Order_Line_Kind._($core.int v, $core.String n) : super(v, n);
}


const _omitEnumNames = $core.bool.fromEnvironment('protobuf.omit_enum_names');
