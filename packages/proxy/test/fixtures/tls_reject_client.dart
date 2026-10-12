// A client that rejects the proxy's certificate the way a pinning / default-trust Dart app does, over a silent
// CONNECT like the entry's gRPC hook. Usage: tls_reject_client <proxyPort> <target host:port>.
// Prints "rejected" or "accepted".
import 'dart:io';

Future<void> main(List<String> args) async {
  final target = args[1];
  try {
    final raw = await Socket.connect('127.0.0.1', int.parse(args[0]));
    raw.write('CONNECT $target HTTP/1.1\r\nHost: $target\r\nFlutter-Intercept-Tunnel: silent\r\n\r\n');
    await raw.flush();
    final s = await SecureSocket.secure(raw, host: 'localhost', supportedProtocols: ['h2']);
    s.destroy();
    print('accepted');
  } on HandshakeException {
    print('rejected');
  } catch (e) {
    print('error $e');
  }
}
