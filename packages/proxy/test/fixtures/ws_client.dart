// WebSocket test client for @flutter-intercept/proxy — dart:io only, no pub dependencies.
//
//   ws_client <proxyPort> <ws(s)://url> [caPemFile]
//
// Configured like the generated entry (CONTRACTS §1): HttpOverrides whose clients use
// findProxy 'PROXY 127.0.0.1:<port>' (no DIRECT fallback, so a proxy failure is visible), and, when a CA
// file is given, that CA trusted on SecurityContext.defaultContext (the install-CA trust; no
// badCertificateCallback). WebSocket.connect goes through HttpClient(), i.e. through the overrides.
//
// Script: waits for the server's "welcome", sends "hello", a binary [1, 2, 3] and "close-me" (the server
// then closes with 4002) — or, with FI_WS_CLIENT_CLOSE=1, closes itself with 4001 "bye" after the echoes.
// Prints "RECV text <t>" / "RECV binary <bytes>" per message and "CLOSED <code> <reason>"; exit 0.
// On failure: "ERROR <type>: <message>"; exit 2.
import 'dart:async';
import 'dart:io';

class _Overrides extends HttpOverrides {
  _Overrides(this.proxyPort);
  final int proxyPort;
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    client.findProxy = (_) => 'PROXY 127.0.0.1:$proxyPort';
    return client;
  }
}

Future<void> main(List<String> args) async {
  final proxyPort = int.parse(args[0]);
  final url = args[1];
  if (args.length > 2) {
    SecurityContext.defaultContext.setTrustedCertificatesBytes(File(args[2]).readAsBytesSync());
  }
  final clientCloses = Platform.environment['FI_WS_CLIENT_CLOSE'] == '1';
  HttpOverrides.global = _Overrides(proxyPort);
  try {
    final ws = await WebSocket.connect(url).timeout(const Duration(seconds: 15));
    final echoes = Completer<void>();
    var got = 0;
    final done = Completer<void>();
    ws.listen(
      (m) {
        if (m is String) {
          stdout.writeln('RECV text $m');
          if (m == 'welcome') {
            ws.add('hello');
            ws.add(<int>[1, 2, 3]);
          }
          if (m.startsWith('echo:')) got++;
        } else {
          stdout.writeln('RECV binary ${(m as List<int>).join(',')}');
          got++;
        }
        if (got == 2 && !echoes.isCompleted) echoes.complete();
      },
      onDone: () => done.complete(),
      onError: (Object e) => done.completeError(e),
    );
    await echoes.future.timeout(const Duration(seconds: 15));
    if (clientCloses) {
      await ws.close(4001, 'bye');
    } else {
      ws.add('close-me');
    }
    await done.future.timeout(const Duration(seconds: 15));
    stdout.writeln('CLOSED ${ws.closeCode} ${ws.closeReason ?? ''}');
    await stdout.flush();
    exit(0);
  } catch (e) {
    stdout.writeln('ERROR ${e.runtimeType}: $e');
    await stdout.flush();
    exit(2);
  }
}
