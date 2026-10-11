// This is a generated file - do not edit.
//
// Generated from demo/orders/v1/orders.proto.

// @dart = 3.3

// ignore_for_file: annotate_overrides, camel_case_types, comment_references
// ignore_for_file: constant_identifier_names
// ignore_for_file: curly_braces_in_flow_control_structures
// ignore_for_file: deprecated_member_use_from_same_package, library_prefixes
// ignore_for_file: non_constant_identifier_names, prefer_relative_imports
// ignore_for_file: unused_import

import 'dart:convert' as $convert;
import 'dart:core' as $core;
import 'dart:typed_data' as $typed_data;

@$core.Deprecated('Use orderStatusDescriptor instead')
const OrderStatus$json = {
  '1': 'OrderStatus',
  '2': [
    {'1': 'ORDER_STATUS_UNSPECIFIED', '2': 0},
    {'1': 'ORDER_STATUS_PENDING', '2': 1},
    {'1': 'ORDER_STATUS_SHIPPED', '2': 2},
    {'1': 'ORDER_STATUS_DELIVERED', '2': 3},
    {'1': 'ORDER_STATUS_CANCELLED', '2': 4},
  ],
};

/// Descriptor for `OrderStatus`. Decode as a `google.protobuf.EnumDescriptorProto`.
final $typed_data.Uint8List orderStatusDescriptor = $convert.base64Decode(
    'CgtPcmRlclN0YXR1cxIcChhPUkRFUl9TVEFUVVNfVU5TUEVDSUZJRUQQABIYChRPUkRFUl9TVE'
    'FUVVNfUEVORElORxABEhgKFE9SREVSX1NUQVRVU19TSElQUEVEEAISGgoWT1JERVJfU1RBVFVT'
    'X0RFTElWRVJFRBADEhoKFk9SREVSX1NUQVRVU19DQU5DRUxMRUQQBA==');

@$core.Deprecated('Use moneyDescriptor instead')
const Money$json = {
  '1': 'Money',
  '2': [
    {'1': 'currency_code', '3': 1, '4': 1, '5': 9, '10': 'currencyCode'},
    {'1': 'units', '3': 2, '4': 1, '5': 3, '10': 'units'},
    {'1': 'nanos', '3': 3, '4': 1, '5': 5, '10': 'nanos'},
  ],
};

/// Descriptor for `Money`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List moneyDescriptor = $convert.base64Decode(
    'CgVNb25leRIjCg1jdXJyZW5jeV9jb2RlGAEgASgJUgxjdXJyZW5jeUNvZGUSFAoFdW5pdHMYAi'
    'ABKANSBXVuaXRzEhQKBW5hbm9zGAMgASgFUgVuYW5vcw==');

@$core.Deprecated('Use lineItemDescriptor instead')
const LineItem$json = {
  '1': 'LineItem',
  '2': [
    {'1': 'sku', '3': 1, '4': 1, '5': 9, '10': 'sku'},
    {'1': 'quantity', '3': 2, '4': 1, '5': 5, '10': 'quantity'},
    {
      '1': 'unit_price',
      '3': 3,
      '4': 1,
      '5': 11,
      '6': '.demo.orders.v1.Money',
      '10': 'unitPrice'
    },
  ],
};

/// Descriptor for `LineItem`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List lineItemDescriptor = $convert.base64Decode(
    'CghMaW5lSXRlbRIQCgNza3UYASABKAlSA3NrdRIaCghxdWFudGl0eRgCIAEoBVIIcXVhbnRpdH'
    'kSNAoKdW5pdF9wcmljZRgDIAEoCzIVLmRlbW8ub3JkZXJzLnYxLk1vbmV5Ugl1bml0UHJpY2U=');

@$core.Deprecated('Use orderDescriptor instead')
const Order$json = {
  '1': 'Order',
  '2': [
    {'1': 'id', '3': 1, '4': 1, '5': 9, '10': 'id'},
    {'1': 'customer_email', '3': 2, '4': 1, '5': 9, '10': 'customerEmail'},
    {
      '1': 'status',
      '3': 3,
      '4': 1,
      '5': 14,
      '6': '.demo.orders.v1.OrderStatus',
      '10': 'status'
    },
    {
      '1': 'items',
      '3': 4,
      '4': 3,
      '5': 11,
      '6': '.demo.orders.v1.LineItem',
      '10': 'items'
    },
    {
      '1': 'total',
      '3': 5,
      '4': 1,
      '5': 11,
      '6': '.demo.orders.v1.Money',
      '10': 'total'
    },
    {
      '1': 'labels',
      '3': 6,
      '4': 3,
      '5': 11,
      '6': '.demo.orders.v1.Order.LabelsEntry',
      '10': 'labels'
    },
    {'1': 'gift', '3': 7, '4': 1, '5': 8, '10': 'gift'},
    {'1': 'weight_kg', '3': 8, '4': 1, '5': 1, '10': 'weightKg'},
    {'1': 'signature', '3': 9, '4': 1, '5': 12, '10': 'signature'},
    {'1': 'pickup_store', '3': 10, '4': 1, '5': 9, '9': 0, '10': 'pickupStore'},
    {
      '1': 'shipping_address',
      '3': 11,
      '4': 1,
      '5': 11,
      '6': '.demo.orders.v1.Order.Address',
      '9': 0,
      '10': 'shippingAddress'
    },
    {
      '1': 'created_at',
      '3': 12,
      '4': 1,
      '5': 11,
      '6': '.google.protobuf.Timestamp',
      '10': 'createdAt'
    },
    {'1': 'tags', '3': 13, '4': 3, '5': 9, '10': 'tags'},
    {'1': 'priority', '3': 14, '4': 1, '5': 13, '10': 'priority'},
    {'1': 'served_to', '3': 15, '4': 1, '5': 9, '10': 'servedTo'},
  ],
  '3': [Order_Address$json, Order_LabelsEntry$json],
  '8': [
    {'1': 'delivery'},
  ],
};

@$core.Deprecated('Use orderDescriptor instead')
const Order_Address$json = {
  '1': 'Address',
  '2': [
    {'1': 'line1', '3': 1, '4': 1, '5': 9, '10': 'line1'},
    {'1': 'city', '3': 2, '4': 1, '5': 9, '10': 'city'},
    {'1': 'country_code', '3': 3, '4': 1, '5': 9, '10': 'countryCode'},
  ],
};

@$core.Deprecated('Use orderDescriptor instead')
const Order_LabelsEntry$json = {
  '1': 'LabelsEntry',
  '2': [
    {'1': 'key', '3': 1, '4': 1, '5': 9, '10': 'key'},
    {'1': 'value', '3': 2, '4': 1, '5': 9, '10': 'value'},
  ],
  '7': {'7': true},
};

/// Descriptor for `Order`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List orderDescriptor = $convert.base64Decode(
    'CgVPcmRlchIOCgJpZBgBIAEoCVICaWQSJQoOY3VzdG9tZXJfZW1haWwYAiABKAlSDWN1c3RvbW'
    'VyRW1haWwSMwoGc3RhdHVzGAMgASgOMhsuZGVtby5vcmRlcnMudjEuT3JkZXJTdGF0dXNSBnN0'
    'YXR1cxIuCgVpdGVtcxgEIAMoCzIYLmRlbW8ub3JkZXJzLnYxLkxpbmVJdGVtUgVpdGVtcxIrCg'
    'V0b3RhbBgFIAEoCzIVLmRlbW8ub3JkZXJzLnYxLk1vbmV5UgV0b3RhbBI5CgZsYWJlbHMYBiAD'
    'KAsyIS5kZW1vLm9yZGVycy52MS5PcmRlci5MYWJlbHNFbnRyeVIGbGFiZWxzEhIKBGdpZnQYBy'
    'ABKAhSBGdpZnQSGwoJd2VpZ2h0X2tnGAggASgBUgh3ZWlnaHRLZxIcCglzaWduYXR1cmUYCSAB'
    'KAxSCXNpZ25hdHVyZRIjCgxwaWNrdXBfc3RvcmUYCiABKAlIAFILcGlja3VwU3RvcmUSSgoQc2'
    'hpcHBpbmdfYWRkcmVzcxgLIAEoCzIdLmRlbW8ub3JkZXJzLnYxLk9yZGVyLkFkZHJlc3NIAFIP'
    'c2hpcHBpbmdBZGRyZXNzEjkKCmNyZWF0ZWRfYXQYDCABKAsyGi5nb29nbGUucHJvdG9idWYuVG'
    'ltZXN0YW1wUgljcmVhdGVkQXQSEgoEdGFncxgNIAMoCVIEdGFncxIaCghwcmlvcml0eRgOIAEo'
    'DVIIcHJpb3JpdHkSGwoJc2VydmVkX3RvGA8gASgJUghzZXJ2ZWRUbxpWCgdBZGRyZXNzEhQKBW'
    'xpbmUxGAEgASgJUgVsaW5lMRISCgRjaXR5GAIgASgJUgRjaXR5EiEKDGNvdW50cnlfY29kZRgD'
    'IAEoCVILY291bnRyeUNvZGUaOQoLTGFiZWxzRW50cnkSEAoDa2V5GAEgASgJUgNrZXkSFAoFdm'
    'FsdWUYAiABKAlSBXZhbHVlOgI4AUIKCghkZWxpdmVyeQ==');

@$core.Deprecated('Use getOrderRequestDescriptor instead')
const GetOrderRequest$json = {
  '1': 'GetOrderRequest',
  '2': [
    {'1': 'id', '3': 1, '4': 1, '5': 9, '10': 'id'},
    {'1': 'include_items', '3': 2, '4': 1, '5': 8, '10': 'includeItems'},
    {'1': 'session_token', '3': 3, '4': 1, '5': 9, '10': 'sessionToken'},
  ],
};

/// Descriptor for `GetOrderRequest`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List getOrderRequestDescriptor = $convert.base64Decode(
    'Cg9HZXRPcmRlclJlcXVlc3QSDgoCaWQYASABKAlSAmlkEiMKDWluY2x1ZGVfaXRlbXMYAiABKA'
    'hSDGluY2x1ZGVJdGVtcxIjCg1zZXNzaW9uX3Rva2VuGAMgASgJUgxzZXNzaW9uVG9rZW4=');

@$core.Deprecated('Use watchOrdersRequestDescriptor instead')
const WatchOrdersRequest$json = {
  '1': 'WatchOrdersRequest',
  '2': [
    {'1': 'customer_email', '3': 1, '4': 1, '5': 9, '10': 'customerEmail'},
    {'1': 'max_events', '3': 2, '4': 1, '5': 5, '10': 'maxEvents'},
    {'1': 'interval_ms', '3': 3, '4': 1, '5': 5, '10': 'intervalMs'},
  ],
};

/// Descriptor for `WatchOrdersRequest`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List watchOrdersRequestDescriptor = $convert.base64Decode(
    'ChJXYXRjaE9yZGVyc1JlcXVlc3QSJQoOY3VzdG9tZXJfZW1haWwYASABKAlSDWN1c3RvbWVyRW'
    '1haWwSHQoKbWF4X2V2ZW50cxgCIAEoBVIJbWF4RXZlbnRzEh8KC2ludGVydmFsX21zGAMgASgF'
    'UgppbnRlcnZhbE1z');

@$core.Deprecated('Use orderEventDescriptor instead')
const OrderEvent$json = {
  '1': 'OrderEvent',
  '2': [
    {'1': 'order_id', '3': 1, '4': 1, '5': 9, '10': 'orderId'},
    {
      '1': 'status',
      '3': 2,
      '4': 1,
      '5': 14,
      '6': '.demo.orders.v1.OrderStatus',
      '10': 'status'
    },
    {'1': 'sequence', '3': 3, '4': 1, '5': 5, '10': 'sequence'},
    {'1': 'served_to', '3': 4, '4': 1, '5': 9, '10': 'servedTo'},
  ],
};

/// Descriptor for `OrderEvent`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List orderEventDescriptor = $convert.base64Decode(
    'CgpPcmRlckV2ZW50EhkKCG9yZGVyX2lkGAEgASgJUgdvcmRlcklkEjMKBnN0YXR1cxgCIAEoDj'
    'IbLmRlbW8ub3JkZXJzLnYxLk9yZGVyU3RhdHVzUgZzdGF0dXMSGgoIc2VxdWVuY2UYAyABKAVS'
    'CHNlcXVlbmNlEhsKCXNlcnZlZF90bxgEIAEoCVIIc2VydmVkVG8=');

@$core.Deprecated('Use uploadSummaryDescriptor instead')
const UploadSummary$json = {
  '1': 'UploadSummary',
  '2': [
    {'1': 'count', '3': 1, '4': 1, '5': 5, '10': 'count'},
    {'1': 'total_quantity', '3': 2, '4': 1, '5': 5, '10': 'totalQuantity'},
    {'1': 'served_to', '3': 3, '4': 1, '5': 9, '10': 'servedTo'},
  ],
};

/// Descriptor for `UploadSummary`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List uploadSummaryDescriptor = $convert.base64Decode(
    'Cg1VcGxvYWRTdW1tYXJ5EhQKBWNvdW50GAEgASgFUgVjb3VudBIlCg50b3RhbF9xdWFudGl0eR'
    'gCIAEoBVINdG90YWxRdWFudGl0eRIbCglzZXJ2ZWRfdG8YAyABKAlSCHNlcnZlZFRv');

@$core.Deprecated('Use chatMessageDescriptor instead')
const ChatMessage$json = {
  '1': 'ChatMessage',
  '2': [
    {'1': 'from', '3': 1, '4': 1, '5': 9, '10': 'from'},
    {'1': 'text', '3': 2, '4': 1, '5': 9, '10': 'text'},
    {'1': 'sequence', '3': 3, '4': 1, '5': 5, '10': 'sequence'},
    {'1': 'served_to', '3': 4, '4': 1, '5': 9, '10': 'servedTo'},
  ],
};

/// Descriptor for `ChatMessage`. Decode as a `google.protobuf.DescriptorProto`.
final $typed_data.Uint8List chatMessageDescriptor = $convert.base64Decode(
    'CgtDaGF0TWVzc2FnZRISCgRmcm9tGAEgASgJUgRmcm9tEhIKBHRleHQYAiABKAlSBHRleHQSGg'
    'oIc2VxdWVuY2UYAyABKAVSCHNlcXVlbmNlEhsKCXNlcnZlZF90bxgEIAEoCVIIc2VydmVkVG8=');
