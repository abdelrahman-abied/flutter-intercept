// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'models.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Profile _$ProfileFromJson(Map<String, dynamic> json) => Profile(
  json['first_name'] as String,
  json['surname'] as String?,
  DateTime.parse(json['created_at'] as String),
  json['website'] == null ? null : Uri.parse(json['website'] as String),
  (json['score'] as num).toDouble(),
  (json['ratio'] as num?)?.toDouble(),
  (json['count'] as num?)?.toInt() ?? 0,
  (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
  (json['scores'] as List<dynamic>?)?.map((e) => (e as num).toInt()).toList(),
  (json['matrix'] as List<dynamic>)
      .map(
        (e) => (e as List<dynamic>).map((e) => (e as num).toDouble()).toList(),
      )
      .toList(),
  (json['items'] as List<dynamic>)
      .map((e) => Item.fromJson(e as Map<String, dynamic>))
      .toList(),
  (json['by_id'] as Map<String, dynamic>).map(
    (k, e) => MapEntry(k, Item.fromJson(e as Map<String, dynamic>)),
  ),
  (json['optional_items'] as List<dynamic>?)
      ?.map((e) => Item.fromJson(e as Map<String, dynamic>))
      .toList(),
  $enumDecode(_$RoleEnumMap, json['role']),
  $enumDecodeNullable(_$RoleEnumMap, json['maybe_role']),
  BigInt.parse(json['big'] as String),
  Duration(microseconds: (json['duration'] as num).toInt()),
  json['flag'] as bool,
  json['extra'] as Map<String, dynamic>,
  const EpochConverter().fromJson((json['epoch'] as num).toInt()),
  $enumDecodeNullable(
    _$StatusEnumMap,
    json['status'],
    unknownValue: JsonKey.nullForUndefinedEnumValue,
  ),
  Item.fromJson(json['nested'] as Map<String, dynamic>),
  json['maybe_nested'] == null
      ? null
      : Item.fromJson(json['maybe_nested'] as Map<String, dynamic>),
  Map<String, String>.from(json['names_by_id'] as Map),
  json['anything'],
  json['maybe_date'] == null
      ? null
      : DateTime.parse(json['maybe_date'] as String),
  (json['set_of'] as List<dynamic>).map((e) => e as String).toSet(),
);

const _$RoleEnumMap = {Role.admin: 'admin', Role.user: 'user'};

const _$StatusEnumMap = {Status.active: 'active', Status.archived: 2};

Item _$ItemFromJson(Map<String, dynamic> json) =>
    $checkedCreate('Item', json, ($checkedConvert) {
      $checkKeys(
        json,
        requiredKeys: const ['label'],
        disallowNullValues: const ['label'],
      );
      final val = Item(
        $checkedConvert('item-id', (v) => (v as num).toInt()),
        $checkedConvert('price', (v) => v as num),
        $checkedConvert('label', (v) => v as String),
        $checkedConvert('qty', (v) => (v as num?)?.toInt() ?? 1),
      );
      return val;
    }, fieldKeyMap: const {'itemId': 'item-id'});

Page<T> _$PageFromJson<T>(
  Map<String, dynamic> json,
  T Function(Object? json) fromJsonT,
) => Page<T>(
  (json['data'] as List<dynamic>).map(fromJsonT).toList(),
  (json['total'] as num).toInt(),
  _$nullableGenericFromJson(json['next'], fromJsonT),
);

T? _$nullableGenericFromJson<T>(
  Object? input,
  T Function(Object? json) fromJson,
) => input == null ? null : fromJson(input);

Pascal _$PascalFromJson(Map<String, dynamic> json) => Pascal(
  json['SomeValue'] as String,
  json['When'] == null ? null : DateTime.parse(json['When'] as String),
);

Screaming _$ScreamingFromJson(Map json) => Screaming(
  json['SOME_VALUE'] as String,
  Item.fromJson(Map<String, dynamic>.from(json['NESTED'] as Map)),
);
