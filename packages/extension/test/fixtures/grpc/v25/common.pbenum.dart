// This is a generated file - do not edit.
//
// Generated from common.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports

import 'dart:core' as $core;

import 'package:protobuf/protobuf.dart' as $pb;

class Level extends $pb.ProtobufEnum {
  static const Level LEVEL_UNSPECIFIED =
      Level._(0, _omitEnumNames ? '' : 'LEVEL_UNSPECIFIED');
  static const Level LEVEL_LOW = Level._(1, _omitEnumNames ? '' : 'LEVEL_LOW');
  static const Level LEVEL_HIGH =
      Level._(2, _omitEnumNames ? '' : 'LEVEL_HIGH');

  static const $core.List<Level> values = <Level>[
    LEVEL_UNSPECIFIED,
    LEVEL_LOW,
    LEVEL_HIGH,
  ];

  static final $core.List<Level?> _byValue =
      $pb.ProtobufEnum.$_initByValueList(values, 2);
  static Level? valueOf($core.int value) =>
      value < 0 || value >= _byValue.length ? null : _byValue[value];

  const Level._(super.value, super.name);
}

const $core.bool _omitEnumNames =
    $core.bool.fromEnvironment('protobuf.omit_enum_names');
