// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'user.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

User _$UserFromJson(Map<String, dynamic> json) => User(
  id: (json['id'] as num).toInt(),
  name: json['name'] as String,
  handle: json['username'] as String,
  email: json['email'] as String,
  address: Address.fromJson(json['address'] as Map<String, dynamic>),
  company: Company.fromJson(json['company'] as Map<String, dynamic>),
  avatarUrl: json['avatar_url'] as String?,
  tier:
      $enumDecodeNullable(
        _$UserTierEnumMap,
        json['tier'],
        unknownValue: UserTier.unknown,
      ) ??
      UserTier.free,
);

Map<String, dynamic> _$UserToJson(User instance) => <String, dynamic>{
  'id': instance.id,
  'name': instance.name,
  'username': instance.handle,
  'email': instance.email,
  'address': instance.address,
  'company': instance.company,
  'avatar_url': instance.avatarUrl,
  'tier': _$UserTierEnumMap[instance.tier]!,
};

const _$UserTierEnumMap = {
  UserTier.free: 'free',
  UserTier.pro: 'pro',
  UserTier.unknown: 'unknown',
};

Address _$AddressFromJson(Map<String, dynamic> json) => Address(
  street: json['street'] as String,
  city: json['city'] as String,
  zipCode: json['zipcode'] as String,
  geo: Geo.fromJson(json['geo'] as Map<String, dynamic>),
);

Map<String, dynamic> _$AddressToJson(Address instance) => <String, dynamic>{
  'street': instance.street,
  'city': instance.city,
  'zipcode': instance.zipCode,
  'geo': instance.geo,
};

Geo _$GeoFromJson(Map<String, dynamic> json) =>
    Geo(lat: json['lat'] as String, lng: json['lng'] as String);

Map<String, dynamic> _$GeoToJson(Geo instance) => <String, dynamic>{
  'lat': instance.lat,
  'lng': instance.lng,
};

Company _$CompanyFromJson(Map<String, dynamic> json) => Company(
  name: json['name'] as String,
  catchPhrase: json['catchPhrase'] as String?,
);

Map<String, dynamic> _$CompanyToJson(Company instance) => <String, dynamic>{
  'name': instance.name,
  'catchPhrase': instance.catchPhrase,
};
