// The platform's own HTTP stack through package:http: cupertino_http (NSURLSession) on iOS/macOS,
// ok_http (OkHttp) on Android. These bypass dart:io, so no
// HttpOverrides (and no proxy setting of a dart:io HttpClient) reaches them. Both report
// requests to package:http_profile, which DevTools and the VM service can read.
import 'dart:io';

import 'package:cupertino_http/cupertino_http.dart';
import 'package:http/http.dart' as http;
import 'package:cronet_http/cronet_http.dart';

/// A native client for this platform, or null where there is none (desktop other than macOS).
http.Client? nativeHttpClient() {
  if (Platform.isAndroid) return CronetClient.defaultCronetEngine();
  if (Platform.isIOS || Platform.isMacOS) return CupertinoClient.defaultSessionConfiguration();
  return null;
}

String get nativeClientName => Platform.isAndroid
    ? 'cronet_http'
    : (Platform.isIOS || Platform.isMacOS)
        ? 'cupertino_http'
        : 'none';
