import 'package:json_annotation/json_annotation.dart';

part 'models.g.dart';

enum Role { admin, user }

enum Status {
  @JsonValue('active')
  active,
  @JsonValue(2)
  archived,
}

class EpochConverter implements JsonConverter<DateTime, int> {
  const EpochConverter();
  @override
  DateTime fromJson(int json) => DateTime.fromMillisecondsSinceEpoch(json);
  @override
  int toJson(DateTime object) => object.millisecondsSinceEpoch;
}

@JsonSerializable(fieldRename: FieldRename.snake, createToJson: false)
class Profile {
  Profile(this.firstName, this.lastName, this.createdAt, this.website, this.score, this.ratio,
      this.count, this.tags, this.scores, this.matrix, this.items, this.byId, this.optionalItems,
      this.role, this.maybeRole, this.big, this.duration, this.flag, this.extra, this.epoch, this.status,
      this.nested, this.maybeNested, this.namesById, this.anything, this.maybeDate, this.setOf);
  final String firstName;
  @JsonKey(name: 'surname')
  final String? lastName;
  final DateTime createdAt;
  final Uri? website;
  final double score;
  final double? ratio;
  @JsonKey(defaultValue: 0)
  final int count;
  final List<String> tags;
  final List<int>? scores;
  final List<List<double>> matrix;
  final List<Item> items;
  final Map<String, Item> byId;
  final List<Item>? optionalItems;
  final Role role;
  final Role? maybeRole;
  final BigInt big;
  final Duration duration;
  @JsonKey(includeIfNull: false)
  final bool flag;
  final Map<String, dynamic> extra;
  @EpochConverter()
  final DateTime epoch;
  @JsonKey(unknownEnumValue: JsonKey.nullForUndefinedEnumValue)
  final Status? status;
  final Item nested;
  final Item? maybeNested;
  final Map<String, String> namesById;
  final dynamic anything;
  final DateTime? maybeDate;
  final Set<String> setOf;
  @JsonKey(includeFromJson: false, includeToJson: false)
  String? ignored;

  factory Profile.fromJson(Map<String, dynamic> json) => _$ProfileFromJson(json);
}

@JsonSerializable(checked: true, createToJson: false, fieldRename: FieldRename.kebab)
class Item {
  Item(this.itemId, this.price, this.label, this.qty);
  final int itemId;
  final num price;
  @JsonKey(required: true, disallowNullValue: true)
  final String label;
  @JsonKey(defaultValue: 1)
  final int qty;
  factory Item.fromJson(Map<String, dynamic> json) => _$ItemFromJson(json);
}

@JsonSerializable(genericArgumentFactories: true, createToJson: false)
class Page<T> {
  Page(this.data, this.total, this.next);
  final List<T> data;
  final int total;
  final T? next;
  factory Page.fromJson(Map<String, dynamic> json, T Function(Object? json) fromJsonT) =>
      _$PageFromJson(json, fromJsonT);
}

@JsonSerializable(createToJson: false, fieldRename: FieldRename.pascal)
class Pascal {
  Pascal(this.someValue, this.when);
  final String someValue;
  final DateTime? when;
  factory Pascal.fromJson(Map<String, dynamic> json) => _$PascalFromJson(json);
}

@JsonSerializable(createToJson: false, fieldRename: FieldRename.screamingSnake, anyMap: true)
class Screaming {
  Screaming(this.someValue, this.nested);
  final String someValue;
  final Item nested;
  factory Screaming.fromJson(Map json) => _$ScreamingFromJson(json);
}
