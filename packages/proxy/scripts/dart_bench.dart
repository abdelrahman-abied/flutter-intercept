// Latency bench: N sequential requests on ONE HttpClient (keep-alive, like a real app),
// optionally through the proxy. dart run dart_bench.dart <url> <n> [proxyPort]
import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> args) async {
  final url = Uri.parse(args[0]);
  final n = int.parse(args[1]);
  final proxyPort = args.length > 2 ? int.parse(args[2]) : null;
  final client = HttpClient()..badCertificateCallback = ((_, __, ___) => true);
  if (proxyPort != null) client.findProxy = (_) => 'PROXY 127.0.0.1:$proxyPort; DIRECT';
  final times = <double>[];
  for (var i = 0; i < n + 1; i++) {
    final sw = Stopwatch()..start();
    final req = await client.getUrl(url);
    final res = await req.close();
    await res.drain<void>();
    sw.stop();
    if (i > 0) times.add(sw.elapsedMicroseconds / 1000.0); // first = connection + cert setup
    else stdout.writeln('first_ms ${(sw.elapsedMicroseconds / 1000.0).toStringAsFixed(2)}');
  }
  times.sort();
  double p(double q) => times[((times.length - 1) * q).round()];
  final mean = times.reduce((a, b) => a + b) / times.length;
  stdout.writeln(jsonEncode({'n': n, 'mean': mean, 'p50': p(0.5), 'p90': p(0.9), 'p99': p(0.99)}));
  client.close(force: true);
}
