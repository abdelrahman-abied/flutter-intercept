// gRPC test server for the demo app's gRPC calls (samples/demo_app/lib/grpc_demo.dart), used by
// scripts/e2e/run_device.sh --grpc and by hand:
//
//   cd scripts/e2e/grpc_server && dart pub get && dart run bin/server.dart --port 50051 [--tls-port 50052]
//
// demo.orders.v1.OrderService (samples/demo_app/protos) on 127.0.0.1 and ::1 (never a wildcard address):
// insecure HTTP/2 (h2c) on --port, and with --tls-port also TLS (ALPN h2) with a self-signed certificate
// (CN=fi-grpc-server, SAN localhost / 127.0.0.1 / ::1 / 10.0.2.2) minted with openssl at start into a
// temporary directory that is deleted once the certificate is loaded (no key is ever kept).
//
// Every response carries `served_to` = the client's address:port as this server saw the TCP connection,
// so a check can tell a direct connection from one relayed by a proxy.
//
// Greppable log lines: GRPC_SERVER_READY, GRPC_CONN <scheme> <peer>, GRPC_CALL <Method> <peer> [...].
import 'dart:async';
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:grpc/grpc.dart';
import 'package:http2/transport.dart' show ServerTransportConnection;
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';

import 'package:fi_grpc_server/src/generated/demo/orders/v1/orders.pbgrpc.dart';

void log(String s) => stdout.writeln('${DateTime.now().toIso8601String()} $s');

const _peerKey = #fiGrpcPeer;
String get _peer => (Zone.current[_peerKey] as String?) ?? '?';

class OrderService extends OrderServiceBase {
  @override
  Future<Order> getOrder(ServiceCall call, GetOrderRequest request) async {
    log('GRPC_CALL GetOrder $_peer id=${request.id}');
    call.headers?['x-demo-server'] = 'fi-grpc-server';
    call.trailers?['x-demo-trailer'] = 'done';
    if (request.id == 'missing') throw const GrpcError.notFound('order "missing" does not exist');
    return Order(
      id: request.id,
      customerEmail: 'ada@example.com',
      status: OrderStatus.ORDER_STATUS_SHIPPED,
      items: request.includeItems
          ? [
              LineItem(sku: 'BEANS-1KG', quantity: 2, unitPrice: Money(currencyCode: 'EUR', units: Int64(14), nanos: 500000000)),
              LineItem(sku: 'FILTER-100', quantity: 1, unitPrice: Money(currencyCode: 'EUR', units: Int64(4))),
            ]
          : null,
      total: Money(currencyCode: 'EUR', units: Int64(33)),
      labels: {'channel': 'app', 'region': 'eu'}.entries,
      gift: true,
      weightKg: 2.25,
      signature: [0xde, 0xad, 0xbe, 0xef],
      shippingAddress: Order_Address(line1: '1 Demo Street', city: 'Cairo', countryCode: 'EG'),
      createdAt: Timestamp.fromDateTime(DateTime.utc(2026, 10, 11, 9, 30)),
      tags: ['coffee', 'priority'],
      priority: 2,
      servedTo: _peer,
    );
  }

  @override
  Stream<OrderEvent> watchOrders(ServiceCall call, WatchOrdersRequest request) async* {
    final n = request.maxEvents > 0 ? request.maxEvents : 3;
    final gap = Duration(milliseconds: request.intervalMs > 0 ? request.intervalMs : 100);
    log('GRPC_CALL WatchOrders $_peer events=$n');
    const statuses = [OrderStatus.ORDER_STATUS_PENDING, OrderStatus.ORDER_STATUS_SHIPPED, OrderStatus.ORDER_STATUS_DELIVERED];
    for (var i = 0; i < n; i++) {
      if (i > 0) await Future<void>.delayed(gap);
      yield OrderEvent(orderId: 'A-1001', status: statuses[i % statuses.length], sequence: i + 1, servedTo: _peer);
    }
  }

  @override
  Future<UploadSummary> uploadItems(ServiceCall call, Stream<LineItem> request) async {
    var count = 0, quantity = 0;
    await for (final item in request) {
      count++;
      quantity += item.quantity;
    }
    log('GRPC_CALL UploadItems $_peer count=$count');
    return UploadSummary(count: count, totalQuantity: quantity, servedTo: _peer);
  }

  @override
  Stream<ChatMessage> chat(ServiceCall call, Stream<ChatMessage> request) async* {
    log('GRPC_CALL Chat $_peer');
    await for (final m in request) {
      yield ChatMessage(from: 'server', text: 'echo: ${m.text}', sequence: m.sequence, servedTo: _peer);
    }
  }
}

final _server = ConnectionServer([OrderService()]);

void _serve(Socket socket, String scheme) {
  final peer = '${socket.remoteAddress.address}:${socket.remotePort}';
  log('GRPC_CONN $scheme $peer');
  socket.setOption(SocketOption.tcpNoDelay, true);
  // Handlers are created in this zone, so the service methods can tell which connection they serve.
  runZoned(() {
    _server.serveConnection(connection: ServerTransportConnection.viaSocket(socket), remoteAddress: socket.remoteAddress);
  }, zoneValues: {_peerKey: peer});
}

Future<SecurityContext> _selfSignedContext() async {
  final dir = await Directory.systemTemp.createTemp('fi_grpc_tls_');
  try {
    final r = await Process.run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=fi-grpc-server', //
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1,IP:10.0.2.2',
      '-keyout', '${dir.path}/key.pem', '-out', '${dir.path}/cert.pem',
    ]);
    if (r.exitCode != 0) throw StateError('openssl failed: ${r.stderr}');
    return SecurityContext()
      ..useCertificateChainBytes(File('${dir.path}/cert.pem').readAsBytesSync())
      ..usePrivateKeyBytes(File('${dir.path}/key.pem').readAsBytesSync())
      ..setAlpnProtocols(['grpc-exp', 'h2'], true);
  } finally {
    await dir.delete(recursive: true);
  }
}

Future<void> main(List<String> argv) async {
  var port = 50051;
  int? tlsPort;
  for (var i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port':
        port = int.parse(argv[++i]);
      case '--tls-port':
        tlsPort = int.parse(argv[++i]);
      default:
        stderr.writeln('unknown arg ${argv[i]}');
        exit(64);
    }
  }
  final closers = <Future<void> Function()>[];
  for (final address in [InternetAddress.loopbackIPv4, InternetAddress.loopbackIPv6]) {
    try {
      final s = await ServerSocket.bind(address, port);
      s.listen((socket) => _serve(socket, 'h2c'));
      closers.add(s.close);
    } on SocketException catch (e) {
      if (address.type == InternetAddressType.IPv4) rethrow;
      log('GRPC_SERVER no IPv6 loopback ($e)');
    }
  }
  if (tlsPort != null) {
    final context = await _selfSignedContext();
    for (final address in [InternetAddress.loopbackIPv4, InternetAddress.loopbackIPv6]) {
      try {
        final s = await SecureServerSocket.bind(address, tlsPort, context);
        s.listen((socket) => _serve(socket, 'tls'), onError: (Object e) => log('GRPC_TLS_ERR $e'));
        closers.add(s.close);
      } on SocketException catch (e) {
        if (address.type == InternetAddressType.IPv4) rethrow;
        log('GRPC_SERVER no IPv6 loopback for TLS ($e)');
      }
    }
  }
  log('GRPC_SERVER_READY port=$port tlsPort=${tlsPort ?? '-'}');
  for (final s in [ProcessSignal.sigint, ProcessSignal.sigterm]) {
    s.watch().listen((_) async {
      log('GRPC_SERVER_STOP');
      for (final c in closers) {
        await c();
      }
      exit(0);
    });
  }
}
