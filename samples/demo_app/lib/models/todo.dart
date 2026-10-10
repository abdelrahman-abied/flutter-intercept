// A list endpoint's item model (json_serializable; todo.g.dart is generated).
import 'package:json_annotation/json_annotation.dart';

part 'todo.g.dart';

@JsonSerializable()
class Todo {
  Todo({required this.userId, required this.id, required this.title, this.completed = false});

  final int userId;
  final int id;
  final String title;

  @JsonKey(defaultValue: false)
  final bool completed;

  factory Todo.fromJson(Map<String, dynamic> json) => _$TodoFromJson(json);
  Map<String, dynamic> toJson() => _$TodoToJson(this);
}
