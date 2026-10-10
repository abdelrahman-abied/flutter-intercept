// Hand-written fixture owner for v3.g.dart.
part 'v3.g.dart';

enum Kind { personal, business }

class Account {
  Account(this.id, this.name);
  final int id;
  final String name;
  List<String> tags;
  Person owner;
  Kind kind;
  Map<String, double> scores;
}

class Person {
  Person(this.fullName);
  final String fullName;
  int age;
}
