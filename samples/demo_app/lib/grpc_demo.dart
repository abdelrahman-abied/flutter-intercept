// gRPC (Flutter Intercept 0.10.0): grpc-dart + protoc-generated code (protos/, lib/src/generated/) against a
// server on the development machine, e.g. `dart run bin/server.dart --port 50051 --tls-port 50052` in
// scripts/e2e/grpc_server. Plain app code, no interception code.
import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/material.dart';
import 'package:grpc/grpc.dart';

import 'src/generated/demo/orders/v1/orders.pbgrpc.dart';

/// `--dart-define=GRPC_PORT=n`: the server's insecure (h2c) port. With it, a gRPC batch runs after the first
/// request batch (and after every hot restart): `DEMO_GRPC start` … `DEMO_GRPC done <n>`. 0 = no batch (the
/// gRPC screen then uses 50051).
const grpcPort = int.fromEnvironment('GRPC_PORT');

/// `--dart-define=GRPC_TLS_PORT=n`: also call the server's TLS port (label `grpc_tls`); 0 = off.
const grpcTlsPort = int.fromEnvironment('GRPC_TLS_PORT');

/// `--dart-define=GRPC_HOST=host`: overrides the host. By default the way apps usually reach a server on the
/// development machine: 10.0.2.2 from the Android emulator, localhost elsewhere.
const grpcHostOverride = String.fromEnvironment('GRPC_HOST');

String get grpcHost => grpcHostOverride.isNotEmpty
    ? grpcHostOverride
    : Platform.isAndroid
    ? '10.0.2.2'
    : 'localhost';

int get _port => grpcPort > 0 ? grpcPort : 50051;

typedef GrpcOutcome = (int, Object?);

// Like many apps: one channel per backend, kept for the app's lifetime.
ClientChannel? _channel;
ClientChannel get channel => _channel ??= ClientChannel(
  grpcHost,
  port: _port,
  options: const ChannelOptions(
    credentials: ChannelCredentials.insecure(),
    connectTimeout: Duration(seconds: 10),
  ),
);

OrderServiceClient _client(ClientChannel c) => OrderServiceClient(
  c,
  options: CallOptions(
    timeout: const Duration(seconds: 15),
    // A credential in metadata (agents must see it redacted).
    metadata: {
      'authorization': 'Bearer demo-grpc-secret',
      'x-demo-client': 'demo_app',
    },
  ),
);

Map<String, Object?> _order(Order o) => {
  'id': o.id,
  'status': o.status.name,
  'items': o.items.length,
  'total': '${o.total.units} ${o.total.currencyCode}',
  'city': o.shippingAddress.city,
  'servedTo': o.servedTo,
};

/// Unary: GetOrder.
Future<GrpcOutcome> grpcUnary([ClientChannel? c]) async {
  final call = _client(c ?? channel).getOrder(
    GetOrderRequest(
      id: 'A-1001',
      includeItems: true,
      sessionToken: 'demo-session-789',
    ),
  );
  final order = await call;
  final headers = await call.headers;
  return (0, {..._order(order), 'server': headers['x-demo-server']});
}

/// Unary that fails: GetOrder("missing") answers NOT_FOUND (printed as `ERR … code: 5`).
Future<GrpcOutcome> grpcMissing() async {
  await _client(channel).getOrder(GetOrderRequest(id: 'missing'));
  return (0, 'unexpected answer');
}

/// Server streaming: WatchOrders, three events 100 ms apart.
Future<GrpcOutcome> grpcServerStream() async {
  final events = await _client(channel)
      .watchOrders(
        WatchOrdersRequest(
          customerEmail: 'ada@example.com',
          maxEvents: 3,
          intervalMs: 100,
        ),
      )
      .toList();
  return (
    0,
    {
      'events': [for (final e in events) '${e.sequence}:${e.status.name}'],
      'servedTo': events.isEmpty ? null : events.last.servedTo,
    },
  );
}

/// Client streaming: UploadItems with three line items.
Future<GrpcOutcome> grpcClientStream() async {
  final items = Stream<LineItem>.fromIterable([
    for (var i = 1; i <= 3; i++)
      LineItem(
        sku: 'SKU-$i',
        quantity: i,
        unitPrice: Money(currencyCode: 'EUR', units: Int64(i * 2)),
      ),
  ]);
  final summary = await _client(channel).uploadItems(items);
  return (
    0,
    {
      'count': summary.count,
      'quantity': summary.totalQuantity,
      'servedTo': summary.servedTo,
    },
  );
}

/// Bidirectional streaming: Chat, each message sent after the previous answer arrived.
Future<GrpcOutcome> grpcBidi() async {
  final outgoing = StreamController<ChatMessage>();
  final replies = <String>[];
  String? servedTo;
  final done = Completer<void>();
  var sent = 0;
  void sendNext() {
    if (sent == 3) {
      outgoing.close();
      return;
    }
    sent++;
    outgoing.add(ChatMessage(from: 'app', text: 'hello $sent', sequence: sent));
  }

  _client(channel)
      .chat(outgoing.stream)
      .listen(
        (m) {
          replies.add(m.text);
          servedTo = m.servedTo;
          sendNext();
        },
        onError: (Object e) => done.isCompleted ? null : done.completeError(e),
        onDone: () => done.isCompleted ? null : done.complete(),
      );
  sendNext();
  await done.future;
  return (0, {'replies': replies, 'servedTo': servedTo});
}

/// TLS: GetOrder on the server's TLS port. The server's certificate is self-signed (a development server), so
/// the app accepts exactly that one in debug: CN=fi-grpc-server.
Future<GrpcOutcome> grpcTls() async {
  final c = ClientChannel(
    grpcHost,
    port: grpcTlsPort,
    options: ChannelOptions(
      credentials: ChannelCredentials.secure(
        onBadCertificate: (cert, host) =>
            cert.subject.contains('fi-grpc-server'),
      ),
    ),
  );
  try {
    return await grpcUnary(c);
  } finally {
    await c.shutdown();
  }
}

/// Unary from `Isolate.run` (named isolate "demo_grpc_worker"), on its own channel.
Future<GrpcOutcome> grpcInIsolate() {
  final host = grpcHost, port = _port;
  return Isolate.run(() async {
    final c = ClientChannel(
      host,
      port: port,
      options: const ChannelOptions(credentials: ChannelCredentials.insecure()),
    );
    try {
      final (status, body) = await grpcUnary(c);
      return (
        status,
        {
          'overridesInIsolate': IOOverrides.current != null,
          ...(body as Map<String, Object?>),
        },
      );
    } finally {
      await c.shutdown();
    }
  }, debugName: 'demo_grpc_worker');
}

/// The gRPC calls by label (lib/demo.dart prints each as a `DEMO_RESULT` line).
final grpcCalls = <String, Future<GrpcOutcome> Function()>{
  'grpc_unary': grpcUnary,
  'grpc_stream': grpcServerStream,
  'grpc_client_stream': grpcClientStream,
  'grpc_bidi': grpcBidi,
  'grpc_missing': grpcMissing,
  'grpc_isolate': grpcInIsolate,
  if (grpcTlsPort > 0) 'grpc_tls': grpcTls,
};

/// A screen with one button per gRPC call and the last results.
class GrpcScreen extends StatefulWidget {
  const GrpcScreen({super.key, required this.run});

  /// Runs one labelled call and returns its result line.
  final Future<String> Function(String label, Future<GrpcOutcome> Function() fn)
  run;

  @override
  State<GrpcScreen> createState() => _GrpcScreenState();
}

class _GrpcScreenState extends State<GrpcScreen> {
  final _results = <String>[];

  Future<void> _call(String label, Future<GrpcOutcome> Function() fn) async {
    final line = await widget.run(label, fn);
    if (mounted) setState(() => _results.insert(0, line));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('gRPC — $grpcHost:$_port')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final e in grpcCalls.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: FilledButton(
                onPressed: () => _call(e.key, e.value),
                child: Text(e.key),
              ),
            ),
          const Divider(),
          for (final r in _results)
            Text(
              r,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            ),
        ],
      ),
    );
  }
}
