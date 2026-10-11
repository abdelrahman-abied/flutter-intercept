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

import 'package:protobuf/protobuf.dart' as $pb;

class Legacy_Kind extends $pb.ProtobufEnum {
  static const Legacy_Kind A = Legacy_Kind._(1, _omitEnumNames ? '' : 'A');
  static const Legacy_Kind B = Legacy_Kind._(2, _omitEnumNames ? '' : 'B');

  static const $core.List<Legacy_Kind> values = <Legacy_Kind> [
    A,
    B,
  ];

  static final $core.Map<$core.int, Legacy_Kind> _byValue = $pb.ProtobufEnum.initByValue(values);
  static Legacy_Kind? valueOf($core.int value) => _byValue[value];

  const Legacy_Kind._($core.int v, $core.String n) : super(v, n);
}


const _omitEnumNames = $core.bool.fromEnvironment('protobuf.omit_enum_names');
