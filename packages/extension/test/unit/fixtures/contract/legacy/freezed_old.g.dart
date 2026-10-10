// GENERATED CODE - DO NOT MODIFY BY HAND
// Hand-written fixture: freezed 0.x–2.3 / 2.4–2.5 naming.

part of 'freezed_old.dart';

_$_Legacy _$_$_LegacyFromJson(Map<String, dynamic> json) {
  return _$_Legacy(
    id: json['id'] as String,
  );
}

_$_Middle _$$_MiddleFromJson(Map<String, dynamic> json) => _$_Middle(
      count: json['count'] as int,
      when: json['when'] == null ? null : DateTime.parse(json['when'] as String),
    );

_$RecentImpl _$$RecentImplFromJson(Map<String, dynamic> json) => _$RecentImpl(
      label: json['label'] as String? ?? 'x',
      values: (json['values'] as List<dynamic>)
          .map((e) => (e as num).toInt())
          .toList(),
      matrix: (json['matrix'] as List<dynamic>?)
          ?.map((e) => (e as List<dynamic>).map((e) => e as String?).toList())
          .toList(),
      createdAt: const EpochConverter().fromJson(json['created_at'] as int),
      mapped: _$JsonConverterFromJson<String, Uri>(json['mapped'], const UriConv().fromJson),
      extra: _readExtra(json, 'extra') as Map<String, dynamic>,
      level: $enumDecodeNullable(_$LevelEnumMap, json['level'],
              unknownValue: Level.other) ??
          Level.low,
    );

const _$LevelEnumMap = {
  Level.low: 1,
  Level.high: 2,
  Level.other: 'other',
};
