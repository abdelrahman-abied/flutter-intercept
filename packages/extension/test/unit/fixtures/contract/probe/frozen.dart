import 'package:freezed_annotation/freezed_annotation.dart';

part 'frozen.freezed.dart';
part 'frozen.g.dart';

@freezed
abstract class Person with _$Person {
  const factory Person({
    required String name,
    @JsonKey(name: 'avatar_url') String? avatarUrl,
    @Default(18) int age,
    @Default(<String>[]) List<String> nicknames,
    required Pet pet,
  }) = _Person;

  factory Person.fromJson(Map<String, dynamic> json) => _$PersonFromJson(json);
}

@freezed
abstract class Pet with _$Pet {
  const factory Pet({required String kind, double? weight}) = _Pet;
  factory Pet.fromJson(Map<String, dynamic> json) => _$PetFromJson(json);
}

@freezed
sealed class Shape with _$Shape {
  const factory Shape.circle(double radius) = Circle;
  const factory Shape.square(double side) = Square;
  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
