// GENERATED CODE - DO NOT MODIFY BY HAND
// Hand-written fixture: json_serializable 3.x (pre-null-safety) output shapes.

part of 'v3.dart';

Account _$AccountFromJson(Map<String, dynamic> json) {
  $checkKeys(json, requiredKeys: const ['id']);
  return Account(
    json['id'] as int,
    json['name'] as String,
  )
    ..tags = (json['tags'] as List)?.map((e) => e as String)?.toList()
    ..owner = json['owner'] == null
        ? null
        : Person.fromJson(json['owner'] as Map<String, dynamic>)
    ..kind = _$enumDecodeNullable(_$KindEnumMap, json['kind'])
    ..scores = (json['scores'] as Map<String, dynamic>)?.map(
      (k, e) => MapEntry(k, (e as num)?.toDouble()),
    );
}

T _$enumDecode<T>(
  Map<T, dynamic> enumValues,
  dynamic source, {
  T unknownValue,
}) {
  if (source == null) {
    throw ArgumentError('A value must be provided. Supported values: '
        '${enumValues.values.join(', ')}');
  }

  final value = enumValues.entries
      .singleWhere((e) => e.value == source, orElse: () => null)
      ?.key;

  if (value == null && unknownValue == null) {
    throw ArgumentError('`$source` is not one of the supported values: '
        '${enumValues.values.join(', ')}');
  }
  return value ?? unknownValue;
}

T _$enumDecodeNullable<T>(
  Map<T, dynamic> enumValues,
  dynamic source, {
  T unknownValue,
}) {
  if (source == null) {
    return null;
  }
  return _$enumDecode<T>(enumValues, source, unknownValue: unknownValue);
}

const _$KindEnumMap = {
  Kind.personal: 'personal',
  Kind.business: 'business',
};

Person _$PersonFromJson(Map<String, dynamic> json) {
  return $checkedNew('Person', json, () {
    final val = Person(
      $checkedConvert(json, 'full_name', (v) => v as String),
    );
    $checkedConvert(json, 'age', (v) => val.age = v as int);
    return val;
  }, fieldKeyMap: const {'fullName': 'full_name'});
}
