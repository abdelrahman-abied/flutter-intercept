// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'order.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Order _$OrderFromJson(Map<String, dynamic> json) => Order(
      json['order_id'] as int,
      (json['total'] as num).toDouble(),
      DateTime.parse(json['placed_at'] as String),
    )
      ..quantity = json['quantity'] as int?
      ..note = json['note'] as String? ?? 'none'
      ..state = $enumDecode(_$OrderStateEnumMap, json['state'])
      ..items = (json['items'] as List<dynamic>?)
          ?.map((e) => LineItem.fromJson(e as Map<String, dynamic>))
          .toList();

const _$OrderStateEnumMap = {
  OrderState.open: 'open',
  OrderState.shipped: 'shipped',
};

LineItem _$LineItemFromJson(Map<String, dynamic> json) => LineItem(
      sku: json['sku'] as String,
      price: (json['price'] as num?)?.toDouble(),
    );
