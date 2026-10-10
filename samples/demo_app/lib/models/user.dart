// Models for jsonplaceholder's /users, the json_serializable way (`dart run build_runner build`
// regenerates user.g.dart). Plain app code: Flutter Intercept's contract check reads the generated
// `_$UserFromJson` to compare real responses with these classes.
import 'package:json_annotation/json_annotation.dart';

part 'user.g.dart';

/// Not sent by jsonplaceholder: missing → [UserTier.free]; a value the app doesn't know → [UserTier.unknown].
enum UserTier {
  @JsonValue('free')
  free,
  @JsonValue('pro')
  pro,
  unknown,
}

@JsonSerializable()
class User {
  User({
    required this.id,
    required this.name,
    required this.handle,
    required this.email,
    required this.address,
    required this.company,
    this.avatarUrl,
    this.tier = UserTier.free,
  });

  final int id;
  final String name;

  /// Renamed key: the API calls it `username`.
  @JsonKey(name: 'username')
  final String handle;

  /// Required: a response without it makes `fromJson` throw
  /// ("type 'Null' is not a subtype of type 'String' in type cast").
  final String email;

  final Address address;
  final Company company;

  /// Optional and not sent by jsonplaceholder.
  @JsonKey(name: 'avatar_url')
  final String? avatarUrl;

  @JsonKey(unknownEnumValue: UserTier.unknown)
  final UserTier tier;

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
  Map<String, dynamic> toJson() => _$UserToJson(this);
}

@JsonSerializable()
class Address {
  Address({required this.street, required this.city, required this.zipCode, required this.geo});

  final String street;
  final String city;

  @JsonKey(name: 'zipcode')
  final String zipCode;

  final Geo geo;

  factory Address.fromJson(Map<String, dynamic> json) => _$AddressFromJson(json);
  Map<String, dynamic> toJson() => _$AddressToJson(this);
}

/// jsonplaceholder sends coordinates as strings ("-37.3159").
@JsonSerializable()
class Geo {
  Geo({required this.lat, required this.lng});

  final String lat;
  final String lng;

  factory Geo.fromJson(Map<String, dynamic> json) => _$GeoFromJson(json);
  Map<String, dynamic> toJson() => _$GeoToJson(this);
}

@JsonSerializable()
class Company {
  Company({required this.name, this.catchPhrase});

  final String name;
  final String? catchPhrase;

  factory Company.fromJson(Map<String, dynamic> json) => _$CompanyFromJson(json);
  Map<String, dynamic> toJson() => _$CompanyToJson(this);
}
