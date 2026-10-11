//
//  Generated code. Do not modify.
//  source: common.proto
//
// @dart = 2.12

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_final_fields
// ignore_for_file: unnecessary_import, unnecessary_this, unused_import

import 'dart:core' as $core;

import 'package:protobuf/protobuf.dart' as $pb;

class Level extends $pb.ProtobufEnum {
  static const Level LEVEL_UNSPECIFIED = Level._(0, _omitEnumNames ? '' : 'LEVEL_UNSPECIFIED');
  static const Level LEVEL_LOW = Level._(1, _omitEnumNames ? '' : 'LEVEL_LOW');
  static const Level LEVEL_HIGH = Level._(2, _omitEnumNames ? '' : 'LEVEL_HIGH');

  static const $core.List<Level> values = <Level> [
    LEVEL_UNSPECIFIED,
    LEVEL_LOW,
    LEVEL_HIGH,
  ];

  static final $core.Map<$core.int, Level> _byValue = $pb.ProtobufEnum.initByValue(values);
  static Level? valueOf($core.int value) => _byValue[value];

  const Level._($core.int v, $core.String n) : super(v, n);
}


const _omitEnumNames = $core.bool.fromEnvironment('protobuf.omit_enum_names');
