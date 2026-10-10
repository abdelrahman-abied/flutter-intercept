// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'frozen.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_Person _$PersonFromJson(Map<String, dynamic> json) => _Person(
  name: json['name'] as String,
  avatarUrl: json['avatar_url'] as String?,
  age: (json['age'] as num?)?.toInt() ?? 18,
  nicknames:
      (json['nicknames'] as List<dynamic>?)?.map((e) => e as String).toList() ??
      const <String>[],
  pet: Pet.fromJson(json['pet'] as Map<String, dynamic>),
);

Map<String, dynamic> _$PersonToJson(_Person instance) => <String, dynamic>{
  'name': instance.name,
  'avatar_url': instance.avatarUrl,
  'age': instance.age,
  'nicknames': instance.nicknames,
  'pet': instance.pet,
};

_Pet _$PetFromJson(Map<String, dynamic> json) => _Pet(
  kind: json['kind'] as String,
  weight: (json['weight'] as num?)?.toDouble(),
);

Map<String, dynamic> _$PetToJson(_Pet instance) => <String, dynamic>{
  'kind': instance.kind,
  'weight': instance.weight,
};

Circle _$CircleFromJson(Map<String, dynamic> json) => Circle(
  (json['radius'] as num).toDouble(),
  $type: json['runtimeType'] as String?,
);

Map<String, dynamic> _$CircleToJson(Circle instance) => <String, dynamic>{
  'radius': instance.radius,
  'runtimeType': instance.$type,
};

Square _$SquareFromJson(Map<String, dynamic> json) => Square(
  (json['side'] as num).toDouble(),
  $type: json['runtimeType'] as String?,
);

Map<String, dynamic> _$SquareToJson(Square instance) => <String, dynamic>{
  'side': instance.side,
  'runtimeType': instance.$type,
};
