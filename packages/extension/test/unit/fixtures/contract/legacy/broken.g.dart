// GENERATED CODE - DO NOT MODIFY BY HAND
// Hand-written fixture: syntax the scanner doesn't model, then a truncated function.
part of 'broken.dart';

Weird _$WeirdFromJson(Map<String, dynamic> json) => Weird(
      a: json['a'] as String,
      b: someCustom(json['b'], (x) { return x?.y ?? [1, 2, ...rest]; }),
      c: _$recordConvert(json['c'], ($jsonValue) => ($jsonValue[r'$1'] as num).toInt()),
      d: switch (json['d']) { 1 => 'one', _ => 'other' },
      e: (json['e'] as num).toDouble(),
      f: [if (json['f'] != null) json['f'] as String],
    );

Unterminated _$UnterminatedFromJson(Map<String, dynamic> json) => Unterminated(
  x: 'oops
