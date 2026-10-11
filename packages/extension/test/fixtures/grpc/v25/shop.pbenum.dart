// This is a generated file - do not edit.
//
// Generated from shop.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports

import 'dart:core' as $core;

import 'package:protobuf/protobuf.dart' as $pb;

class Color extends $pb.ProtobufEnum {
  static const Color COLOR_UNSPECIFIED =
      Color._(0, _omitEnumNames ? '' : 'COLOR_UNSPECIFIED');
  static const Color RED = Color._(1, _omitEnumNames ? '' : 'RED');
  static const Color GREEN = Color._(2, _omitEnumNames ? '' : 'GREEN');
  static const Color BLUE = Color._(3, _omitEnumNames ? '' : 'BLUE');

  static const $core.List<Color> values = <Color>[
    COLOR_UNSPECIFIED,
    RED,
    GREEN,
    BLUE,
  ];

  static final $core.List<Color?> _byValue =
      $pb.ProtobufEnum.$_initByValueList(values, 3);
  static Color? valueOf($core.int value) =>
      value < 0 || value >= _byValue.length ? null : _byValue[value];

  const Color._(super.value, super.name);
}

class Order_Line_Kind extends $pb.ProtobufEnum {
  static const Order_Line_Kind KIND_UNSPECIFIED =
      Order_Line_Kind._(0, _omitEnumNames ? '' : 'KIND_UNSPECIFIED');
  static const Order_Line_Kind PHYSICAL =
      Order_Line_Kind._(1, _omitEnumNames ? '' : 'PHYSICAL');
  static const Order_Line_Kind DIGITAL =
      Order_Line_Kind._(2, _omitEnumNames ? '' : 'DIGITAL');

  static const $core.List<Order_Line_Kind> values = <Order_Line_Kind>[
    KIND_UNSPECIFIED,
    PHYSICAL,
    DIGITAL,
  ];

  static final $core.List<Order_Line_Kind?> _byValue =
      $pb.ProtobufEnum.$_initByValueList(values, 2);
  static Order_Line_Kind? valueOf($core.int value) =>
      value < 0 || value >= _byValue.length ? null : _byValue[value];

  const Order_Line_Kind._(super.value, super.name);
}

const $core.bool _omitEnumNames =
    $core.bool.fromEnvironment('protobuf.omit_enum_names');
