// Emits protobuf bytes (base64) + toProto3Json() pairs from the real Dart runtime (protobuf 6.1.0,
// protoc_plugin 25.1.0 output) for the TypeScript codec tests.
import 'dart:convert';
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:protobuf/protobuf.dart';
import 'package:protobuf/well_known_types/google/protobuf/any.pb.dart';
import 'package:protobuf/well_known_types/google/protobuf/duration.pb.dart';
import 'package:protobuf/well_known_types/google/protobuf/empty.pb.dart';
import 'package:protobuf/well_known_types/google/protobuf/field_mask.pb.dart';
import 'package:protobuf/well_known_types/google/protobuf/struct.pb.dart';
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';
import 'package:protobuf/well_known_types/google/protobuf/wrappers.pb.dart';
import 'package:vec/gen/common.pb.dart';
import 'package:vec/gen/legacy.pb.dart';
import 'package:vec/gen/nopkg.pb.dart';
import 'package:vec/gen/shop.pb.dart';

final registry = TypeRegistry([Money(), Order_Line(), Scalars(), Timestamp()]);

// The JSON comes from the message parsed back from its own bytes, as a receiver would see it.
Map<String, Object?> vec(String name, String type, GeneratedMessage m) {
  final bytes = m.writeToBuffer();
  final parsed = m.createEmptyInstance()..mergeFromBuffer(bytes);
  return {
    'name': name,
    'type': type,
    'base64': base64Encode(bytes),
    'json': parsed.toProto3Json(typeRegistry: registry),
  };
}

void main(List<String> args) {
  final out = <Map<String, Object?>>[];

  out.add(vec('scalars: typical', 'fi.shop.v1.Scalars', Scalars(
    d: 3.25, f: 1.1, i32: -42, i64: Int64(-9007199254740993), u32: 4000000000,
    u64: Int64.parseHex('ffffffffffffffff'), s32: -7, s64: Int64.parseInt('-9223372036854775808'),
    fx32: 4294967295, fx64: Int64.parseInt('1234567890123'), sfx32: -2147483648,
    sfx64: Int64.parseInt('-5'), b: true, s: 'héllo ✓ 😀', by: [0, 1, 2, 250, 255],
    optI32: 0, optS: '', color: Color.BLUE,
  )));
  out.add(vec('scalars: extremes', 'fi.shop.v1.Scalars', Scalars(
    d: double.infinity, f: double.negativeInfinity, i32: 2147483647, i64: Int64.MAX_VALUE,
    u32: 1, s32: -2147483648, s64: Int64.MAX_VALUE, fx64: Int64.parseHex('ffffffffffffffff'),
    sfx64: Int64.MIN_VALUE,
  )));
  out.add(vec('scalars: nan', 'fi.shop.v1.Scalars', Scalars(d: double.nan, f: 0.5)));
  out.add(vec('scalars: empty', 'fi.shop.v1.Scalars', Scalars()));

  out.add(vec('repeats', 'fi.shop.v1.Repeats', Repeats(
    d: [1.5, -2.0, 0.0], f: [0.25], i32: [1, -1, 300], i64: [Int64(1), Int64(-1), Int64.MAX_VALUE],
    u32: [0, 4294967295], u64: [Int64.parseHex('8000000000000000')], s32: [-1, 1, -64],
    s64: [Int64(-3)], fx32: [7], fx64: [Int64(8)], sfx32: [-9], sfx64: [Int64(-10)],
    b: [true, false, true], s: ['a', '', 'ccc'], by: [[1], [], [255, 254]],
    colors: [Color.RED, Color.GREEN, Color.COLOR_UNSPECIFIED],
    moneys: [Money(currency: 'EUR', units: Int64(12), nanos: 500000000), Money()],
    unpacked: [5, -6, 70000],
  )));

  final line = Order_Line(
    sku: 'SKU-1', qty: 3, price: Money(currency: 'USD', units: Int64(9), nanos: 990000000),
    kind: Order_Line_Kind.DIGITAL, notes: [Order_Line_Note(text: 'gift wrap'), Order_Line_Note()],
  );
  final order = Order(
    orderId: 'o-1',
    lines: [line, Order_Line(sku: 'SKU-2')],
    labels: {'env': 'dev', 'empty': ''}.entries,
    linesByNo: <int, Order_Line>{1: line, -2: Order_Line(qty: 1)}.entries,
    colorsByName: {'sky': Color.BLUE, 'none': Color.COLOR_UNSPECIFIED}.entries,
    flags: {Int64(-1): true, Int64.MAX_VALUE: false}.entries,
    blobs: <bool, List<int>>{true: [1, 2, 3], false: []}.entries,
    levels: {Int64.parseHex('ffffffffffffffff'): Level.LEVEL_HIGH}.entries,
    cash: Money(currency: 'JPY', units: Int64(1000)),
    createdAt: Timestamp(seconds: Int64(1700000000), nanos: 123000000),
    ttl: Duration(seconds: Int64(90), nanos: 500000000),
    note: StringValue(value: 'leave at door'),
    big: Int64Value(value: Int64.parseInt('-9223372036854775807')),
    meta: Struct(fields: {
      'n': Value(numberValue: 1.5),
      's': Value(stringValue: 'x'),
      'b': Value(boolValue: true),
      'z': Value(nullValue: NullValue.NULL_VALUE),
      'l': Value(listValue: ListValue(values: [Value(numberValue: 1), Value(stringValue: 'two')])),
      'o': Value(structValue: Struct(fields: {'k': Value(boolValue: false)}.entries)),
    }.entries),
    anyValue: Value(stringValue: 'any'),
    mask: FieldMask(paths: ['order_id', 'lines.sku', 'created_at']),
    extra: Any.pack(Money(currency: 'GBP', units: Int64(5))),
    gift: BoolValue(value: true),
    parent: Order(orderId: 'p-0', cardToken: 'tok_123', level: Level.LEVEL_LOW),
    level: Level.LEVEL_HIGH,
    class_31: 'reserved word',
    custom: 'custom json name',
    listValue: ListValue(values: [Value(nullValue: NullValue.NULL_VALUE), Value(boolValue: true)]),
    rawValue: BytesValue(value: utf8.encode('raw')),
  );
  out.add(vec('order: everything', 'fi.shop.v1.Order', order));
  out.add(vec('order: oneof invoice', 'fi.shop.v1.Order', Order(orderId: 'o-2', invoice: true)));
  out.add(vec('order: timestamp/duration edge', 'fi.shop.v1.Order', Order(
    createdAt: Timestamp(seconds: Int64(-62135596800)),
    ttl: Duration(seconds: Int64(-3), nanos: -1000),
    extra: Any.pack(Timestamp(seconds: Int64(1), nanos: 1)),
    big: Int64Value(),
    gift: BoolValue(),
  )));
  out.add(vec('order line', 'fi.shop.v1.Order.Line', line));
  out.add(vec('outer', 'fi.shop.v1.Outer', Outer(
    inner: Outer_Inner_(z: 1), flat: Outer_Inner(y: 2), list: List_(x: 3))));
  out.add(vec('money', 'fi.common.Money', Money(currency: 'CHF', units: Int64(-1), nanos: -1)));

  final legacy = Legacy(
    id: 'L1', count: 0, nums: [1, 2, 3], loose: [4, 5], kind: Legacy_Kind.A,
    sub: Legacy_Sub(v: 0), data: [], big: Int64.parseHex('fffffffffffffffe'), neg: Int64(-2),
    f64: Int64(3), ratio: 0.5, flt: -0.0, subs: [Legacy_Sub(v: 1), Legacy_Sub(v: -1)],
    kinds: [Legacy_Kind.B, Legacy_Kind.A], name: 'none',
  );
  out.add(vec('legacy proto2 (defaults present on the wire)', 'fi.legacy.Legacy', legacy));
  out.add(vec('bare (no package, recursive)', 'Bare',
      Bare(a: 'root', children: [Bare(a: 'c1', children: [Bare(a: 'g')]), Bare()])));
  out.add(vec('empty', 'google.protobuf.Empty', Empty()));

  // Unknown fields: a Money parsed as GetOrderRequest keeps fields 2 and 3 as unknown.
  final unknown = GetOrderRequest.fromBuffer(
      Money(currency: 'USD', units: Int64(7), nanos: 3).writeToBuffer());
  out.add({
    'name': 'unknown fields (Money bytes read as GetOrderRequest)',
    'type': 'fi.shop.v1.GetOrderRequest',
    'base64': base64Encode(unknown.writeToBuffer()),
  });

  File(args.isNotEmpty ? args[0] : 'vectors.json')
      .writeAsStringSync(const JsonEncoder.withIndent('  ').convert(out));
}
