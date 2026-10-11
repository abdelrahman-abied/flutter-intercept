// This is a generated file - do not edit.
//
// Generated from demo/orders/v1/orders.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports

import 'dart:core' as $core;

import 'package:fixnum/fixnum.dart' as $fixnum;
import 'package:protobuf/protobuf.dart' as $pb;
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart'
    as $1;

import 'orders.pbenum.dart';

export 'package:protobuf/protobuf.dart' show GeneratedMessageGenericExtensions;

export 'orders.pbenum.dart';

class Money extends $pb.GeneratedMessage {
  factory Money({
    $core.String? currencyCode,
    $fixnum.Int64? units,
    $core.int? nanos,
  }) {
    final result = Money._();
    if (currencyCode != null) result.currencyCode = currencyCode;
    if (units != null) result.units = units;
    if (nanos != null) result.nanos = nanos;
    return result;
  }

  Money._();

  factory Money.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Money()..mergeFromBuffer(data, registry);
  factory Money.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Money()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Money',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: Money.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'currencyCode')
    ..aInt64(2, _omitFieldNames ? '' : 'units')
    ..aI(3, _omitFieldNames ? '' : 'nanos')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Money clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Money copyWith(void Function(Money) updates) =>
      super.copyWith((message) => updates(message as Money)) as Money;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use Money() / Money.new instead')
  static Money create() => Money._();
  static $pb.GeneratedMessage $_createMessage() => Money._();
  @$core.override
  Money createEmptyInstance() => Money._();
  @$core.pragma('dart2js:noInline')
  static Money getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Money>(Money.$_createMessage);
  static Money? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get currencyCode => $_getSZ(0);
  @$pb.TagNumber(1)
  set currencyCode($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasCurrencyCode() => $_has(0);
  @$pb.TagNumber(1)
  void clearCurrencyCode() => $_clearField(1);

  @$pb.TagNumber(2)
  $fixnum.Int64 get units => $_getI64(1);
  @$pb.TagNumber(2)
  set units($fixnum.Int64 value) => $_setInt64(1, value);
  @$pb.TagNumber(2)
  $core.bool hasUnits() => $_has(1);
  @$pb.TagNumber(2)
  void clearUnits() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.int get nanos => $_getIZ(2);
  @$pb.TagNumber(3)
  set nanos($core.int value) => $_setSignedInt32(2, value);
  @$pb.TagNumber(3)
  $core.bool hasNanos() => $_has(2);
  @$pb.TagNumber(3)
  void clearNanos() => $_clearField(3);
}

class LineItem extends $pb.GeneratedMessage {
  factory LineItem({
    $core.String? sku,
    $core.int? quantity,
    Money? unitPrice,
  }) {
    final result = LineItem._();
    if (sku != null) result.sku = sku;
    if (quantity != null) result.quantity = quantity;
    if (unitPrice != null) result.unitPrice = unitPrice;
    return result;
  }

  LineItem._();

  factory LineItem.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      LineItem()..mergeFromBuffer(data, registry);
  factory LineItem.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      LineItem()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'LineItem',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: LineItem.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'sku')
    ..aI(2, _omitFieldNames ? '' : 'quantity')
    ..aOM<Money>(3, _omitFieldNames ? '' : 'unitPrice',
        subBuilder: Money.$_createMessage)
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  LineItem clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  LineItem copyWith(void Function(LineItem) updates) =>
      super.copyWith((message) => updates(message as LineItem)) as LineItem;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use LineItem() / LineItem.new instead')
  static LineItem create() => LineItem._();
  static $pb.GeneratedMessage $_createMessage() => LineItem._();
  @$core.override
  LineItem createEmptyInstance() => LineItem._();
  @$core.pragma('dart2js:noInline')
  static LineItem getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<LineItem>(LineItem.$_createMessage);
  static LineItem? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get sku => $_getSZ(0);
  @$pb.TagNumber(1)
  set sku($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasSku() => $_has(0);
  @$pb.TagNumber(1)
  void clearSku() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.int get quantity => $_getIZ(1);
  @$pb.TagNumber(2)
  set quantity($core.int value) => $_setSignedInt32(1, value);
  @$pb.TagNumber(2)
  $core.bool hasQuantity() => $_has(1);
  @$pb.TagNumber(2)
  void clearQuantity() => $_clearField(2);

  @$pb.TagNumber(3)
  Money get unitPrice => $_getN(2);
  @$pb.TagNumber(3)
  set unitPrice(Money value) => $_setField(3, value);
  @$pb.TagNumber(3)
  $core.bool hasUnitPrice() => $_has(2);
  @$pb.TagNumber(3)
  void clearUnitPrice() => $_clearField(3);
  @$pb.TagNumber(3)
  Money ensureUnitPrice() => $_ensure(2);
}

class Order_Address extends $pb.GeneratedMessage {
  factory Order_Address({
    $core.String? line1,
    $core.String? city,
    $core.String? countryCode,
  }) {
    final result = Order_Address._();
    if (line1 != null) result.line1 = line1;
    if (city != null) result.city = city;
    if (countryCode != null) result.countryCode = countryCode;
    return result;
  }

  Order_Address._();

  factory Order_Address.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Order_Address()..mergeFromBuffer(data, registry);
  factory Order_Address.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Order_Address()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Order.Address',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: Order_Address.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'line1')
    ..aOS(2, _omitFieldNames ? '' : 'city')
    ..aOS(3, _omitFieldNames ? '' : 'countryCode')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order_Address clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order_Address copyWith(void Function(Order_Address) updates) =>
      super.copyWith((message) => updates(message as Order_Address))
          as Order_Address;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use Order_Address() / Order_Address.new instead')
  static Order_Address create() => Order_Address._();
  static $pb.GeneratedMessage $_createMessage() => Order_Address._();
  @$core.override
  Order_Address createEmptyInstance() => Order_Address._();
  @$core.pragma('dart2js:noInline')
  static Order_Address getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<Order_Address>(
          Order_Address.$_createMessage);
  static Order_Address? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get line1 => $_getSZ(0);
  @$pb.TagNumber(1)
  set line1($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasLine1() => $_has(0);
  @$pb.TagNumber(1)
  void clearLine1() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.String get city => $_getSZ(1);
  @$pb.TagNumber(2)
  set city($core.String value) => $_setString(1, value);
  @$pb.TagNumber(2)
  $core.bool hasCity() => $_has(1);
  @$pb.TagNumber(2)
  void clearCity() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.String get countryCode => $_getSZ(2);
  @$pb.TagNumber(3)
  set countryCode($core.String value) => $_setString(2, value);
  @$pb.TagNumber(3)
  $core.bool hasCountryCode() => $_has(2);
  @$pb.TagNumber(3)
  void clearCountryCode() => $_clearField(3);
}

enum Order_Delivery { pickupStore, shippingAddress, notSet }

class Order extends $pb.GeneratedMessage {
  factory Order({
    $core.String? id,
    $core.String? customerEmail,
    OrderStatus? status,
    $core.Iterable<LineItem>? items,
    Money? total,
    $core.Iterable<$core.MapEntry<$core.String, $core.String>>? labels,
    $core.bool? gift,
    $core.double? weightKg,
    $core.List<$core.int>? signature,
    $core.String? pickupStore,
    Order_Address? shippingAddress,
    $1.Timestamp? createdAt,
    $core.Iterable<$core.String>? tags,
    $core.int? priority,
    $core.String? servedTo,
  }) {
    final result = Order._();
    if (id != null) result.id = id;
    if (customerEmail != null) result.customerEmail = customerEmail;
    if (status != null) result.status = status;
    if (items != null) result.items.addAll(items);
    if (total != null) result.total = total;
    if (labels != null) result.labels.addEntries(labels);
    if (gift != null) result.gift = gift;
    if (weightKg != null) result.weightKg = weightKg;
    if (signature != null) result.signature = signature;
    if (pickupStore != null) result.pickupStore = pickupStore;
    if (shippingAddress != null) result.shippingAddress = shippingAddress;
    if (createdAt != null) result.createdAt = createdAt;
    if (tags != null) result.tags.addAll(tags);
    if (priority != null) result.priority = priority;
    if (servedTo != null) result.servedTo = servedTo;
    return result;
  }

  Order._();

  factory Order.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Order()..mergeFromBuffer(data, registry);
  factory Order.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      Order()..mergeFromJson(json, registry);

  static const $core.Map<$core.int, Order_Delivery> _Order_DeliveryByTag = {
    10: Order_Delivery.pickupStore,
    11: Order_Delivery.shippingAddress,
    0: Order_Delivery.notSet
  };
  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'Order',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: Order.$_createMessage)
    ..oo(0, [10, 11])
    ..aOS(1, _omitFieldNames ? '' : 'id')
    ..aOS(2, _omitFieldNames ? '' : 'customerEmail')
    ..aE<OrderStatus>(3, _omitFieldNames ? '' : 'status',
        enumValues: OrderStatus.values)
    ..pPM<LineItem>(4, _omitFieldNames ? '' : 'items',
        subBuilder: LineItem.$_createMessage)
    ..aOM<Money>(5, _omitFieldNames ? '' : 'total',
        subBuilder: Money.$_createMessage)
    ..m<$core.String, $core.String>(6, _omitFieldNames ? '' : 'labels',
        entryClassName: 'Order.LabelsEntry',
        keyFieldType: $pb.PbFieldType.OS,
        valueFieldType: $pb.PbFieldType.OS,
        packageName: const $pb.PackageName('demo.orders.v1'))
    ..aOB(7, _omitFieldNames ? '' : 'gift')
    ..aD(8, _omitFieldNames ? '' : 'weightKg')
    ..a<$core.List<$core.int>>(
        9, _omitFieldNames ? '' : 'signature', $pb.PbFieldType.OY)
    ..aOS(10, _omitFieldNames ? '' : 'pickupStore')
    ..aOM<Order_Address>(11, _omitFieldNames ? '' : 'shippingAddress',
        subBuilder: Order_Address.$_createMessage)
    ..aOM<$1.Timestamp>(12, _omitFieldNames ? '' : 'createdAt',
        subBuilder: $1.Timestamp.$_createMessage)
    ..pPS(13, _omitFieldNames ? '' : 'tags')
    ..aI(14, _omitFieldNames ? '' : 'priority', fieldType: $pb.PbFieldType.OU3)
    ..aOS(15, _omitFieldNames ? '' : 'servedTo')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  Order copyWith(void Function(Order) updates) =>
      super.copyWith((message) => updates(message as Order)) as Order;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use Order() / Order.new instead')
  static Order create() => Order._();
  static $pb.GeneratedMessage $_createMessage() => Order._();
  @$core.override
  Order createEmptyInstance() => Order._();
  @$core.pragma('dart2js:noInline')
  static Order getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<Order>(Order.$_createMessage);
  static Order? _defaultInstance;

  @$pb.TagNumber(10)
  @$pb.TagNumber(11)
  Order_Delivery whichDelivery() => _Order_DeliveryByTag[$_whichOneof(0)]!;
  @$pb.TagNumber(10)
  @$pb.TagNumber(11)
  void clearDelivery() => $_clearField($_whichOneof(0));

  @$pb.TagNumber(1)
  $core.String get id => $_getSZ(0);
  @$pb.TagNumber(1)
  set id($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasId() => $_has(0);
  @$pb.TagNumber(1)
  void clearId() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.String get customerEmail => $_getSZ(1);
  @$pb.TagNumber(2)
  set customerEmail($core.String value) => $_setString(1, value);
  @$pb.TagNumber(2)
  $core.bool hasCustomerEmail() => $_has(1);
  @$pb.TagNumber(2)
  void clearCustomerEmail() => $_clearField(2);

  @$pb.TagNumber(3)
  OrderStatus get status => $_getN(2);
  @$pb.TagNumber(3)
  set status(OrderStatus value) => $_setField(3, value);
  @$pb.TagNumber(3)
  $core.bool hasStatus() => $_has(2);
  @$pb.TagNumber(3)
  void clearStatus() => $_clearField(3);

  @$pb.TagNumber(4)
  $pb.PbList<LineItem> get items => $_getList(3);

  @$pb.TagNumber(5)
  Money get total => $_getN(4);
  @$pb.TagNumber(5)
  set total(Money value) => $_setField(5, value);
  @$pb.TagNumber(5)
  $core.bool hasTotal() => $_has(4);
  @$pb.TagNumber(5)
  void clearTotal() => $_clearField(5);
  @$pb.TagNumber(5)
  Money ensureTotal() => $_ensure(4);

  @$pb.TagNumber(6)
  $pb.PbMap<$core.String, $core.String> get labels => $_getMap(5);

  @$pb.TagNumber(7)
  $core.bool get gift => $_getBF(6);
  @$pb.TagNumber(7)
  set gift($core.bool value) => $_setBool(6, value);
  @$pb.TagNumber(7)
  $core.bool hasGift() => $_has(6);
  @$pb.TagNumber(7)
  void clearGift() => $_clearField(7);

  @$pb.TagNumber(8)
  $core.double get weightKg => $_getN(7);
  @$pb.TagNumber(8)
  set weightKg($core.double value) => $_setDouble(7, value);
  @$pb.TagNumber(8)
  $core.bool hasWeightKg() => $_has(7);
  @$pb.TagNumber(8)
  void clearWeightKg() => $_clearField(8);

  @$pb.TagNumber(9)
  $core.List<$core.int> get signature => $_getN(8);
  @$pb.TagNumber(9)
  set signature($core.List<$core.int> value) => $_setBytes(8, value);
  @$pb.TagNumber(9)
  $core.bool hasSignature() => $_has(8);
  @$pb.TagNumber(9)
  void clearSignature() => $_clearField(9);

  @$pb.TagNumber(10)
  $core.String get pickupStore => $_getSZ(9);
  @$pb.TagNumber(10)
  set pickupStore($core.String value) => $_setString(9, value);
  @$pb.TagNumber(10)
  $core.bool hasPickupStore() => $_has(9);
  @$pb.TagNumber(10)
  void clearPickupStore() => $_clearField(10);

  @$pb.TagNumber(11)
  Order_Address get shippingAddress => $_getN(10);
  @$pb.TagNumber(11)
  set shippingAddress(Order_Address value) => $_setField(11, value);
  @$pb.TagNumber(11)
  $core.bool hasShippingAddress() => $_has(10);
  @$pb.TagNumber(11)
  void clearShippingAddress() => $_clearField(11);
  @$pb.TagNumber(11)
  Order_Address ensureShippingAddress() => $_ensure(10);

  @$pb.TagNumber(12)
  $1.Timestamp get createdAt => $_getN(11);
  @$pb.TagNumber(12)
  set createdAt($1.Timestamp value) => $_setField(12, value);
  @$pb.TagNumber(12)
  $core.bool hasCreatedAt() => $_has(11);
  @$pb.TagNumber(12)
  void clearCreatedAt() => $_clearField(12);
  @$pb.TagNumber(12)
  $1.Timestamp ensureCreatedAt() => $_ensure(11);

  @$pb.TagNumber(13)
  $pb.PbList<$core.String> get tags => $_getList(12);

  @$pb.TagNumber(14)
  $core.int get priority => $_getIZ(13);
  @$pb.TagNumber(14)
  set priority($core.int value) => $_setUnsignedInt32(13, value);
  @$pb.TagNumber(14)
  $core.bool hasPriority() => $_has(13);
  @$pb.TagNumber(14)
  void clearPriority() => $_clearField(14);

  /// Which connection the server saw (host:port of the peer), for the device checks.
  @$pb.TagNumber(15)
  $core.String get servedTo => $_getSZ(14);
  @$pb.TagNumber(15)
  set servedTo($core.String value) => $_setString(14, value);
  @$pb.TagNumber(15)
  $core.bool hasServedTo() => $_has(14);
  @$pb.TagNumber(15)
  void clearServedTo() => $_clearField(15);
}

class GetOrderRequest extends $pb.GeneratedMessage {
  factory GetOrderRequest({
    $core.String? id,
    $core.bool? includeItems,
    $core.String? sessionToken,
  }) {
    final result = GetOrderRequest._();
    if (id != null) result.id = id;
    if (includeItems != null) result.includeItems = includeItems;
    if (sessionToken != null) result.sessionToken = sessionToken;
    return result;
  }

  GetOrderRequest._();

  factory GetOrderRequest.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      GetOrderRequest()..mergeFromBuffer(data, registry);
  factory GetOrderRequest.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      GetOrderRequest()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'GetOrderRequest',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: GetOrderRequest.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'id')
    ..aOB(2, _omitFieldNames ? '' : 'includeItems')
    ..aOS(3, _omitFieldNames ? '' : 'sessionToken')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  GetOrderRequest clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  GetOrderRequest copyWith(void Function(GetOrderRequest) updates) =>
      super.copyWith((message) => updates(message as GetOrderRequest))
          as GetOrderRequest;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use GetOrderRequest() / GetOrderRequest.new instead')
  static GetOrderRequest create() => GetOrderRequest._();
  static $pb.GeneratedMessage $_createMessage() => GetOrderRequest._();
  @$core.override
  GetOrderRequest createEmptyInstance() => GetOrderRequest._();
  @$core.pragma('dart2js:noInline')
  static GetOrderRequest getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<GetOrderRequest>(
          GetOrderRequest.$_createMessage);
  static GetOrderRequest? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get id => $_getSZ(0);
  @$pb.TagNumber(1)
  set id($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasId() => $_has(0);
  @$pb.TagNumber(1)
  void clearId() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.bool get includeItems => $_getBF(1);
  @$pb.TagNumber(2)
  set includeItems($core.bool value) => $_setBool(1, value);
  @$pb.TagNumber(2)
  $core.bool hasIncludeItems() => $_has(1);
  @$pb.TagNumber(2)
  void clearIncludeItems() => $_clearField(2);

  /// A credential in a message body (agents must see it redacted).
  @$pb.TagNumber(3)
  $core.String get sessionToken => $_getSZ(2);
  @$pb.TagNumber(3)
  set sessionToken($core.String value) => $_setString(2, value);
  @$pb.TagNumber(3)
  $core.bool hasSessionToken() => $_has(2);
  @$pb.TagNumber(3)
  void clearSessionToken() => $_clearField(3);
}

class WatchOrdersRequest extends $pb.GeneratedMessage {
  factory WatchOrdersRequest({
    $core.String? customerEmail,
    $core.int? maxEvents,
    $core.int? intervalMs,
  }) {
    final result = WatchOrdersRequest._();
    if (customerEmail != null) result.customerEmail = customerEmail;
    if (maxEvents != null) result.maxEvents = maxEvents;
    if (intervalMs != null) result.intervalMs = intervalMs;
    return result;
  }

  WatchOrdersRequest._();

  factory WatchOrdersRequest.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      WatchOrdersRequest()..mergeFromBuffer(data, registry);
  factory WatchOrdersRequest.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      WatchOrdersRequest()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'WatchOrdersRequest',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: WatchOrdersRequest.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'customerEmail')
    ..aI(2, _omitFieldNames ? '' : 'maxEvents')
    ..aI(3, _omitFieldNames ? '' : 'intervalMs')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  WatchOrdersRequest clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  WatchOrdersRequest copyWith(void Function(WatchOrdersRequest) updates) =>
      super.copyWith((message) => updates(message as WatchOrdersRequest))
          as WatchOrdersRequest;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use WatchOrdersRequest() / WatchOrdersRequest.new instead')
  static WatchOrdersRequest create() => WatchOrdersRequest._();
  static $pb.GeneratedMessage $_createMessage() => WatchOrdersRequest._();
  @$core.override
  WatchOrdersRequest createEmptyInstance() => WatchOrdersRequest._();
  @$core.pragma('dart2js:noInline')
  static WatchOrdersRequest getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<WatchOrdersRequest>(
          WatchOrdersRequest.$_createMessage);
  static WatchOrdersRequest? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get customerEmail => $_getSZ(0);
  @$pb.TagNumber(1)
  set customerEmail($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasCustomerEmail() => $_has(0);
  @$pb.TagNumber(1)
  void clearCustomerEmail() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.int get maxEvents => $_getIZ(1);
  @$pb.TagNumber(2)
  set maxEvents($core.int value) => $_setSignedInt32(1, value);
  @$pb.TagNumber(2)
  $core.bool hasMaxEvents() => $_has(1);
  @$pb.TagNumber(2)
  void clearMaxEvents() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.int get intervalMs => $_getIZ(2);
  @$pb.TagNumber(3)
  set intervalMs($core.int value) => $_setSignedInt32(2, value);
  @$pb.TagNumber(3)
  $core.bool hasIntervalMs() => $_has(2);
  @$pb.TagNumber(3)
  void clearIntervalMs() => $_clearField(3);
}

class OrderEvent extends $pb.GeneratedMessage {
  factory OrderEvent({
    $core.String? orderId,
    OrderStatus? status,
    $core.int? sequence,
    $core.String? servedTo,
  }) {
    final result = OrderEvent._();
    if (orderId != null) result.orderId = orderId;
    if (status != null) result.status = status;
    if (sequence != null) result.sequence = sequence;
    if (servedTo != null) result.servedTo = servedTo;
    return result;
  }

  OrderEvent._();

  factory OrderEvent.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      OrderEvent()..mergeFromBuffer(data, registry);
  factory OrderEvent.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      OrderEvent()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'OrderEvent',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: OrderEvent.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'orderId')
    ..aE<OrderStatus>(2, _omitFieldNames ? '' : 'status',
        enumValues: OrderStatus.values)
    ..aI(3, _omitFieldNames ? '' : 'sequence')
    ..aOS(4, _omitFieldNames ? '' : 'servedTo')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  OrderEvent clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  OrderEvent copyWith(void Function(OrderEvent) updates) =>
      super.copyWith((message) => updates(message as OrderEvent)) as OrderEvent;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use OrderEvent() / OrderEvent.new instead')
  static OrderEvent create() => OrderEvent._();
  static $pb.GeneratedMessage $_createMessage() => OrderEvent._();
  @$core.override
  OrderEvent createEmptyInstance() => OrderEvent._();
  @$core.pragma('dart2js:noInline')
  static OrderEvent getDefault() => _defaultInstance ??=
      $pb.GeneratedMessage.$_defaultFor<OrderEvent>(OrderEvent.$_createMessage);
  static OrderEvent? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get orderId => $_getSZ(0);
  @$pb.TagNumber(1)
  set orderId($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasOrderId() => $_has(0);
  @$pb.TagNumber(1)
  void clearOrderId() => $_clearField(1);

  @$pb.TagNumber(2)
  OrderStatus get status => $_getN(1);
  @$pb.TagNumber(2)
  set status(OrderStatus value) => $_setField(2, value);
  @$pb.TagNumber(2)
  $core.bool hasStatus() => $_has(1);
  @$pb.TagNumber(2)
  void clearStatus() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.int get sequence => $_getIZ(2);
  @$pb.TagNumber(3)
  set sequence($core.int value) => $_setSignedInt32(2, value);
  @$pb.TagNumber(3)
  $core.bool hasSequence() => $_has(2);
  @$pb.TagNumber(3)
  void clearSequence() => $_clearField(3);

  @$pb.TagNumber(4)
  $core.String get servedTo => $_getSZ(3);
  @$pb.TagNumber(4)
  set servedTo($core.String value) => $_setString(3, value);
  @$pb.TagNumber(4)
  $core.bool hasServedTo() => $_has(3);
  @$pb.TagNumber(4)
  void clearServedTo() => $_clearField(4);
}

class UploadSummary extends $pb.GeneratedMessage {
  factory UploadSummary({
    $core.int? count,
    $core.int? totalQuantity,
    $core.String? servedTo,
  }) {
    final result = UploadSummary._();
    if (count != null) result.count = count;
    if (totalQuantity != null) result.totalQuantity = totalQuantity;
    if (servedTo != null) result.servedTo = servedTo;
    return result;
  }

  UploadSummary._();

  factory UploadSummary.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      UploadSummary()..mergeFromBuffer(data, registry);
  factory UploadSummary.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      UploadSummary()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'UploadSummary',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: UploadSummary.$_createMessage)
    ..aI(1, _omitFieldNames ? '' : 'count')
    ..aI(2, _omitFieldNames ? '' : 'totalQuantity')
    ..aOS(3, _omitFieldNames ? '' : 'servedTo')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  UploadSummary clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  UploadSummary copyWith(void Function(UploadSummary) updates) =>
      super.copyWith((message) => updates(message as UploadSummary))
          as UploadSummary;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use UploadSummary() / UploadSummary.new instead')
  static UploadSummary create() => UploadSummary._();
  static $pb.GeneratedMessage $_createMessage() => UploadSummary._();
  @$core.override
  UploadSummary createEmptyInstance() => UploadSummary._();
  @$core.pragma('dart2js:noInline')
  static UploadSummary getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<UploadSummary>(
          UploadSummary.$_createMessage);
  static UploadSummary? _defaultInstance;

  @$pb.TagNumber(1)
  $core.int get count => $_getIZ(0);
  @$pb.TagNumber(1)
  set count($core.int value) => $_setSignedInt32(0, value);
  @$pb.TagNumber(1)
  $core.bool hasCount() => $_has(0);
  @$pb.TagNumber(1)
  void clearCount() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.int get totalQuantity => $_getIZ(1);
  @$pb.TagNumber(2)
  set totalQuantity($core.int value) => $_setSignedInt32(1, value);
  @$pb.TagNumber(2)
  $core.bool hasTotalQuantity() => $_has(1);
  @$pb.TagNumber(2)
  void clearTotalQuantity() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.String get servedTo => $_getSZ(2);
  @$pb.TagNumber(3)
  set servedTo($core.String value) => $_setString(2, value);
  @$pb.TagNumber(3)
  $core.bool hasServedTo() => $_has(2);
  @$pb.TagNumber(3)
  void clearServedTo() => $_clearField(3);
}

class ChatMessage extends $pb.GeneratedMessage {
  factory ChatMessage({
    $core.String? from,
    $core.String? text,
    $core.int? sequence,
    $core.String? servedTo,
  }) {
    final result = ChatMessage._();
    if (from != null) result.from = from;
    if (text != null) result.text = text;
    if (sequence != null) result.sequence = sequence;
    if (servedTo != null) result.servedTo = servedTo;
    return result;
  }

  ChatMessage._();

  factory ChatMessage.fromBuffer($core.List<$core.int> data,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      ChatMessage()..mergeFromBuffer(data, registry);
  factory ChatMessage.fromJson($core.String json,
          [$pb.ExtensionRegistry registry = $pb.ExtensionRegistry.EMPTY]) =>
      ChatMessage()..mergeFromJson(json, registry);

  static final $pb.BuilderInfo _i = $pb.BuilderInfo(
      _omitMessageNames ? '' : 'ChatMessage',
      package: const $pb.PackageName(_omitMessageNames ? '' : 'demo.orders.v1'),
      createEmptyInstance: ChatMessage.$_createMessage)
    ..aOS(1, _omitFieldNames ? '' : 'from')
    ..aOS(2, _omitFieldNames ? '' : 'text')
    ..aI(3, _omitFieldNames ? '' : 'sequence')
    ..aOS(4, _omitFieldNames ? '' : 'servedTo')
    ..hasRequiredFields = false;

  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  ChatMessage clone() => deepCopy();
  @$core.Deprecated('See https://github.com/google/protobuf.dart/issues/998.')
  ChatMessage copyWith(void Function(ChatMessage) updates) =>
      super.copyWith((message) => updates(message as ChatMessage))
          as ChatMessage;

  @$core.override
  $pb.BuilderInfo get info_ => _i;

  @$core.pragma('dart2js:noInline')
  @$core.Deprecated('Use ChatMessage() / ChatMessage.new instead')
  static ChatMessage create() => ChatMessage._();
  static $pb.GeneratedMessage $_createMessage() => ChatMessage._();
  @$core.override
  ChatMessage createEmptyInstance() => ChatMessage._();
  @$core.pragma('dart2js:noInline')
  static ChatMessage getDefault() =>
      _defaultInstance ??= $pb.GeneratedMessage.$_defaultFor<ChatMessage>(
          ChatMessage.$_createMessage);
  static ChatMessage? _defaultInstance;

  @$pb.TagNumber(1)
  $core.String get from => $_getSZ(0);
  @$pb.TagNumber(1)
  set from($core.String value) => $_setString(0, value);
  @$pb.TagNumber(1)
  $core.bool hasFrom() => $_has(0);
  @$pb.TagNumber(1)
  void clearFrom() => $_clearField(1);

  @$pb.TagNumber(2)
  $core.String get text => $_getSZ(1);
  @$pb.TagNumber(2)
  set text($core.String value) => $_setString(1, value);
  @$pb.TagNumber(2)
  $core.bool hasText() => $_has(1);
  @$pb.TagNumber(2)
  void clearText() => $_clearField(2);

  @$pb.TagNumber(3)
  $core.int get sequence => $_getIZ(2);
  @$pb.TagNumber(3)
  set sequence($core.int value) => $_setSignedInt32(2, value);
  @$pb.TagNumber(3)
  $core.bool hasSequence() => $_has(2);
  @$pb.TagNumber(3)
  void clearSequence() => $_clearField(3);

  @$pb.TagNumber(4)
  $core.String get servedTo => $_getSZ(3);
  @$pb.TagNumber(4)
  set servedTo($core.String value) => $_setString(3, value);
  @$pb.TagNumber(4)
  $core.bool hasServedTo() => $_has(3);
  @$pb.TagNumber(4)
  void clearServedTo() => $_clearField(4);
}

const $core.bool _omitFieldNames =
    $core.bool.fromEnvironment('protobuf.omit_field_names');
const $core.bool _omitMessageNames =
    $core.bool.fromEnvironment('protobuf.omit_message_names');
