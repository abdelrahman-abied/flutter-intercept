// Hand-written fixture owner for freezed_old.g.dart.
part 'freezed_old.freezed.dart';
part 'freezed_old.g.dart';

@freezed
class Legacy with _$Legacy {
  const factory Legacy({required String id}) = _Legacy;
  factory Legacy.fromJson(Map<String, dynamic> json) => _$LegacyFromJson(json);
}

@freezed
class Middle with _$Middle {
  const factory Middle({
    required int count,
    DateTime? when,
  }) = _Middle;
  factory Middle.fromJson(Map<String, dynamic> json) => _$MiddleFromJson(json);
}

@freezed
class Recent with _$Recent {
  const factory Recent({
    @Default('x') String label,
    required List<int> values,
    List<List<String?>>? matrix,
    @EpochConverter() required DateTime createdAt,
    @UriConv() Uri? mapped,
    @JsonKey(readValue: _readExtra) required Map<String, dynamic> extra,
    @JsonKey(unknownEnumValue: Level.other) @Default(Level.low) Level level,
  }) = _Recent;
  factory Recent.fromJson(Map<String, dynamic> json) => _$RecentFromJson(json);
}
