// Test MITM proxy for device E2E checks (dart:io only, no packages).
//
//   dart run scripts/e2e/mitm_proxy.dart --port 8899 --certs <dir> [--ca <dir>]
//
// --ca <dir>: act like the real extension proxy — <dir>/ca.pem + ca.key (a CA,
//   generated with openssl if missing, random subject) signs one leaf per CONNECT
//   host with subjectAltName=<host>, served by a per-host internal TLS server.
//   Without --ca every host gets the same self-signed cert from --certs (the
//   pre-v3 behaviour, which only works with an accept-any client).
//        [--mock <substr>]... [--block <substr>]... [--no-edit]
//
// - CONNECT host:443  -> 200, bytes piped into an internal TLS HttpServer
//   (self-signed cert from <dir>/cert.pem + key.pem, generated with openssl if
//   missing; clients must accept any cert).
// - absolute-form plain http requests -> piped into an internal plain HttpServer.
// - Every request: forwarded upstream with autoUncompress=false. JSON object
//   responses are edited: `"_intercepted": true` is inserted first and a `name`
//   field becomes "EDITED BY TOOL". gzip bodies are decompressed, edited and
//   re-gzipped (Content-Encoding kept).
// - --mock <substr>: URL containing substr -> 200 synthetic JSON, no upstream.
// - --block <substr>: URL containing substr -> 403 {"blocked":true}, no upstream.
//
// LAN mode (CONTRACTS §7, physical iPhone): --bind <LAN IPv4> --token <t>. Binds exactly that
// address (never 0.0.0.0), requires `Proxy-Authorization: Basic base64("flutter-intercept:<t>")` on
// every proxy request / CONNECT (constant-time compare; else 407 + close), and refuses upstream
// targets that are loopback, link-local, unspecified or an address of this Mac (403). The token is
// never logged.
//
// Trace sink (CONTRACTS §9.1/§9.2, template v4): host trace.flutter-intercept.invalid is answered
// locally (204, never forwarded); each trace is logged as `PROXY_TRACE <id> <stack as a JSON string>`.
// The request header `x-fi-id` is logged (`fi=<id>` on PROXY_REQ) and stripped before upstream.
//
// Greppable log lines: PROXY_READY, PROXY_REQ, PROXY_EDIT, PROXY_PASS,
// PROXY_MOCK, PROXY_BLOCK, PROXY_ERR, PROXY_TRACE.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

late final List<String> mocks;
late final List<String> blocks;
late final bool edit;
String? _token;
final Set<String> _ownAddresses = {};
final upstream = HttpClient()
  ..autoUncompress = false
  ..userAgent = null
  ..connectionTimeout = const Duration(seconds: 20);

void log(String s) => stdout.writeln('${DateTime.now().toIso8601String()} $s');

Future<void> main(List<String> argv) async {
  var port = 8899;
  String? certs;
  String? caDir;
  String? bindHost;
  final m = <String>[], b = <String>[];
  var e = true;
  for (var i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port':
        port = int.parse(argv[++i]);
      case '--certs':
        certs = argv[++i];
      case '--ca':
        caDir = argv[++i];
      case '--mock':
        m.add(argv[++i]);
      case '--block':
        b.add(argv[++i]);
      case '--bind':
        bindHost = argv[++i];
      case '--token':
        _token = argv[++i];
      case '--no-edit':
        e = false;
      default:
        stderr.writeln('unknown arg ${argv[i]}');
        exit(64);
    }
  }
  mocks = m;
  blocks = b;
  edit = e;
  certs ??= '${Directory.systemTemp.path}/fi_mitm_certs';
  await _ensureCerts(certs);
  final ctx = SecurityContext()
    ..useCertificateChain('$certs/cert.pem')
    ..usePrivateKey('$certs/key.pem');

  final tls = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
  tls.listen((req) => _handle(req, 'https'));
  if (caDir != null) {
    await _ensureCa(caDir);
    _leafPort = (host) => _leafServer(caDir!, host);
  }
  final plain = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  plain.listen((req) => _handle(req, 'http'));

  final bindAddress = bindHost == null ? InternetAddress.loopbackIPv4 : InternetAddress(bindHost);
  if (bindAddress.address == '0.0.0.0' || bindAddress.address == '::') {
    stderr.writeln('refusing to bind a wildcard address');
    exit(64);
  }
  final server = await ServerSocket.bind(bindAddress, port);
  if (server.address.address != bindAddress.address) {
    stderr.writeln('bound ${server.address.address}, expected ${bindAddress.address}: failing closed');
    exit(70);
  }
  if (_token != null) {
    for (final i in await NetworkInterface.list(includeLoopback: true, includeLinkLocal: true)) {
      for (final a in i.addresses) {
        _ownAddresses.add(a.address);
      }
    }
  }
  server.listen((c) => _accept(c, tls.port, plain.port));
  log('PROXY_READY port=$port bind=${bindAddress.address} auth=${_token != null} edit=$edit mocks=$mocks blocks=$blocks');

  for (final s in [ProcessSignal.sigint, ProcessSignal.sigterm]) {
    s.watch().listen((_) async {
      log('PROXY_STOP');
      await server.close();
      exit(0);
    });
  }
}

/// OpenSSL >= 3.4 can backdate certificates (`-not_before`); device clocks (Android emulator) often
/// lag the host by seconds, which would make a just-minted certificate "not yet valid".
final String _openssl = File('/opt/homebrew/bin/openssl').existsSync() ? '/opt/homebrew/bin/openssl' : 'openssl';
List<String> _validity(int days) {
  if (_openssl == 'openssl') return ['-days', '$days'];
  String asn1(DateTime t) {
    final u = t.toUtc();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${u.year}${two(u.month)}${two(u.day)}${two(u.hour)}${two(u.minute)}${two(u.second)}Z';
  }
  final now = DateTime.now();
  return ['-not_before', asn1(now.subtract(const Duration(days: 1))), '-not_after', asn1(now.add(Duration(days: days)))];
}

/// host -> port of an internal TLS server presenting a CA-signed leaf for host.
Future<int> Function(String host)? _leafPort;
final _leafServers = <String, Future<int>>{};

Future<void> _ensureCa(String dir) async {
  if (File('$dir/ca.pem').existsSync() && File('$dir/ca.key').existsSync()) return;
  Directory(dir).createSync(recursive: true);
  File('$dir/ca.ext').writeAsStringSync(
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
  final cn = 'Flutter Intercept Test CA ${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}';
  for (final cmd in [
    ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=$cn', '-keyout', '$dir/ca.key', '-out', '$dir/ca.csr'],
    ['x509', '-req', '-in', '$dir/ca.csr', '-signkey', '$dir/ca.key', ..._validity(3650), '-sha256',
      '-extfile', '$dir/ca.ext', '-out', '$dir/ca.pem'],
  ]) {
    final r = await Process.run(_openssl, cmd);
    if (r.exitCode != 0) throw StateError('openssl ${cmd.first} failed: ${r.stderr}');
  }
  log('PROXY_CA generated $dir/ca.pem CN="$cn"');
}

Future<int> _leafServer(String caDir, String host) => _leafServers[host] ??= () async {
      final dir = '$caDir/leaf_${host.replaceAll(RegExp(r'[^A-Za-z0-9.-]'), '_')}';
      Directory(dir).createSync(recursive: true);
      final isIp = InternetAddress.tryParse(host) != null;
      File('$dir/ext').writeAsStringSync('subjectAltName=${isIp ? 'IP' : 'DNS'}:$host\n'
          'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
          'extendedKeyUsage=serverAuth\n');
      final serial = '0x${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}';
      for (final cmd in [
        ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=$host', '-keyout', '$dir/key.pem', '-out', '$dir/csr.pem'],
        ['x509', '-req', '-in', '$dir/csr.pem', '-CA', '$caDir/ca.pem', '-CAkey', '$caDir/ca.key', '-set_serial', serial,
          ..._validity(30), '-sha256', '-extfile', '$dir/ext', '-out', '$dir/cert.pem'],
      ]) {
        final r = await Process.run(_openssl, cmd);
        if (r.exitCode != 0) throw StateError('openssl leaf for $host failed: ${r.stderr}');
      }
      final ctx = SecurityContext()
        ..useCertificateChain('$dir/cert.pem')
        ..usePrivateKey('$dir/key.pem');
      final server = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
      server.listen((req) => _handle(req, 'https'));
      log('PROXY_LEAF $host port=${server.port}');
      return server.port;
    }();

Future<void> _ensureCerts(String dir) async {
  if (File('$dir/cert.pem').existsSync() && File('$dir/key.pem').existsSync()) return;
  Directory(dir).createSync(recursive: true);
  final r = await Process.run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-subj', '/CN=flutter-intercept-test', //
    '-keyout', '$dir/key.pem', '-out', '$dir/cert.pem',
  ]);
  if (r.exitCode != 0) throw StateError('openssl failed: ${r.stderr}');
}

/// Reads the first request head, then pipes the connection into the internal
/// TLS server (CONNECT) or plain server (absolute-form http).
void _accept(Socket client, int tlsPort, int plainPort) {
  final buf = <int>[];
  Socket? tunnel;
  var connecting = false;
  late StreamSubscription<List<int>> sub;
  sub = client.listen((data) async {
    if (tunnel != null) {
      tunnel!.add(data);
      return;
    }
    buf.addAll(data);
    if (connecting) return;
    final head = latin1.decode(buf, allowInvalid: true);
    final end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    connecting = true;
    sub.pause();
    final isConnect = head.startsWith('CONNECT ');
    if (_token != null && !_authorized(head)) {
      final firstLine = head.substring(0, head.indexOf('\r\n'));
      log('PROXY_407 ${firstLine.split(' ').take(2).join(' ')} from ${client.remoteAddress.address}');
      client.add(latin1.encode('HTTP/1.1 407 Proxy Authentication Required\r\n'
          'Proxy-Authenticate: Basic realm="flutter-intercept"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
      await client.flush().catchError((_) {});
      client.destroy();
      return;
    }
    try {
      var target = isConnect ? tlsPort : plainPort;
      if (isConnect && _leafPort != null) {
        final authority = head.substring(8, head.indexOf(' ', 8));
        final host = authority.startsWith('[')
            ? authority.substring(1, authority.indexOf(']'))
            : authority.substring(0, authority.lastIndexOf(':') < 0 ? authority.length : authority.lastIndexOf(':'));
        target = await _leafPort!(host);
      }
      final t = await Socket.connect(InternetAddress.loopbackIPv4, target);
      tunnel = t;
      t.listen(client.add, onDone: () => client.destroy(), onError: (_) => client.destroy());
      if (isConnect) {
        log('PROXY_CONNECT ${head.substring(8, head.indexOf(' ', 8))}');
        client.add(latin1.encode('HTTP/1.1 200 Connection established\r\n\r\n'));
        final rest = buf.sublist(end + 4);
        if (rest.isNotEmpty) t.add(rest);
      } else {
        t.add(buf);
      }
      buf.clear();
    } catch (e) {
      log('PROXY_ERR tunnel $e');
      client.destroy();
    }
    sub.resume();
  }, onDone: () => tunnel?.destroy(), onError: (_) => tunnel?.destroy());
}

bool _authorized(String head) {
  final want = utf8.encode('Basic ${base64.encode(utf8.encode('flutter-intercept:$_token'))}');
  String? got;
  for (final line in head.split('\r\n').skip(1)) {
    final i = line.indexOf(':');
    if (i > 0 && line.substring(0, i).trim().toLowerCase() == 'proxy-authorization') {
      got = line.substring(i + 1).trim();
    }
  }
  final g = utf8.encode(got ?? '');
  var diff = g.length ^ want.length;
  for (var i = 0; i < want.length; i++) {
    diff |= want[i] ^ (i < g.length ? g[i] : 0);
  }
  return diff == 0;
}

/// LAN mode: never let a LAN client reach this Mac's own services or other local-only targets.
Future<bool> _forbiddenTarget(String host) async {
  try {
    final addrs = InternetAddress.tryParse(host) != null
        ? [InternetAddress(host)]
        : await InternetAddress.lookup(host);
    return addrs.any((a) =>
        a.isLoopback || a.isLinkLocal || a.address == '0.0.0.0' || a.address == '::' || _ownAddresses.contains(a.address));
  } catch (_) {
    return false; // unresolvable: the upstream fetch fails on its own
  }
}

Future<void> _handle(HttpRequest req, String scheme) async {
  final Uri url;
  if (req.uri.hasScheme) {
    url = req.uri;
  } else {
    url = Uri.parse('$scheme://${req.headers.value('host')}${req.uri}');
  }
  final ua = req.headers.value('user-agent');
  if (url.host == traceHost) {
    await _traceSink(req);
    return;
  }
  final fi = req.headers.value('x-fi-id');
  log('PROXY_REQ ${req.method} $url ua="$ua"${fi == null ? '' : ' fi=$fi'}');
  final s = url.toString();
  try {
    if (_token != null && await _forbiddenTarget(url.host)) {
      log('PROXY_REFUSED local target $url');
      req.response
        ..statusCode = 403
        ..headers.contentType = ContentType.json
        ..write('{"refused":"local target"}');
      await req.response.close();
      return;
    }
    if (blocks.any(s.contains)) {
      log('PROXY_BLOCK $url');
      req.response
        ..statusCode = 403
        ..headers.contentType = ContentType.json
        ..write('{"blocked":true}');
      await req.response.close();
      return;
    }
    if (mocks.any(s.contains)) {
      log('PROXY_MOCK $url');
      req.response
        ..statusCode = 200
        ..headers.contentType = ContentType.json
        ..write('{"mocked":true,"id":2,"name":"MOCKED BY TOOL"}');
      await req.response.close();
      return;
    }
    final body = await req.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    final upReq = await upstream.openUrl(req.method, url);
    upReq.followRedirects = false;
    req.headers.forEach((name, values) {
      if (const {'host', 'proxy-connection', 'proxy-authorization', 'connection', 'content-length', 'transfer-encoding', 'x-fi-id'}
          .contains(name)) {
        return;
      }
      upReq.headers.set(name, values, preserveHeaderCase: true);
    });
    upReq.contentLength = body.length;
    upReq.add(body);
    final up = await upReq.close();
    var bytes = await up.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    final enc = up.headers.value('content-encoding');
    final isGzip = enc == 'gzip';
    final isJson = up.headers.contentType?.subType == 'json';
    var edited = false;
    if (edit && isJson && (enc == null || isGzip)) {
      try {
        final text = utf8.decode(isGzip ? gzip.decode(bytes) : bytes);
        final obj = jsonDecode(text);
        if (obj is Map<String, dynamic>) {
          final out = <String, dynamic>{'_intercepted': true, ...obj};
          if (out.containsKey('name')) out['name'] = 'EDITED BY TOOL';
          final outBytes = utf8.encode(jsonEncode(out));
          bytes = isGzip ? gzip.encode(outBytes) : outBytes;
          edited = true;
        }
      } catch (e) {
        log('PROXY_ERR edit $url $e');
      }
    }
    final res = req.response..statusCode = up.statusCode;
    up.headers.forEach((name, values) {
      if (const {'content-length', 'transfer-encoding', 'connection'}.contains(name)) return;
      for (final v in values) {
        res.headers.add(name, v, preserveHeaderCase: true);
      }
    });
    res.contentLength = bytes.length;
    res.add(bytes);
    await res.close();
    log('${edited ? 'PROXY_EDIT' : 'PROXY_PASS'} ${up.statusCode} ${req.method} $url '
        'gzip=$isGzip bytes=${bytes.length}');
  } catch (e) {
    log('PROXY_ERR $url $e');
    try {
      req.response
        ..statusCode = 502
        ..write('proxy error: $e');
      await req.response.close();
    } catch (_) {}
  }
}

const traceHost = 'trace.flutter-intercept.invalid';

/// Template v4 side channel: `{"traces":[{"id","stack"}]}` -> one PROXY_TRACE line per trace, 204.
Future<void> _traceSink(HttpRequest req) async {
  try {
    final body = await req.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    final obj = jsonDecode(utf8.decode(body)) as Map<String, dynamic>;
    for (final t in (obj['traces'] as List).cast<Map<String, dynamic>>()) {
      log('PROXY_TRACE ${t['id']} ${jsonEncode(t['stack'])}');
    }
  } catch (e) {
    log('PROXY_ERR trace $e');
  }
  req.response.statusCode = 204;
  await req.response.close();
}
