// Hand-written fixture: the model side of order.g.dart (json_serializable 4.x–6.7 style output).
import 'package:json_annotation/json_annotation.dart';

part 'order.g.dart';

enum OrderState { open, shipped }

@JsonSerializable(fieldRename: FieldRename.snake)
class Order {
  Order(this.orderId, this.total, this.placedAt);

  final int orderId;
  final double total;
  final DateTime placedAt;
  int? quantity;
  String? note;
  late OrderState state;
  List<LineItem>? items;
}

@JsonSerializable()
class LineItem {
  LineItem({required this.sku, this.price});
  final String sku;
  final double? price;
}
