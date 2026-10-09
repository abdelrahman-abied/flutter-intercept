// Catalog API: Dio with interceptors, the way many apps structure their API layer.
// Plain app code, no interception/proxy code of any kind.
import 'package:dio/dio.dart';

/// Adds an auth header after an async lookup (e.g. a token read from secure storage or a
/// refresh), serialised like most token-refresh interceptors.
class DemoAuthInterceptor extends QueuedInterceptor {
  String? _token;

  Future<String> _loadToken() async {
    await Future<void>.delayed(const Duration(milliseconds: 2));
    return _token ??= 'demo-catalog-token';
  }

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    options.headers['Authorization'] = 'Bearer ${await _loadToken()}';
    handler.next(options);
  }
}

/// Tags every request with a client header (synchronous interceptor).
class DemoClientHeaderInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers['X-Demo-Client'] = 'demo_app';
    handler.next(options);
  }
}

class CatalogApi {
  CatalogApi(this._dio);
  final Dio _dio;

  /// `GET https://jsonplaceholder.typicode.com/albums/{id}`
  Future<Response<Object?>> fetchAlbum(int id) =>
      _dio.get<Object?>('https://jsonplaceholder.typicode.com/albums/$id');

  /// `GET https://jsonplaceholder.typicode.com/photos?albumId={albumId}&_limit={limit}`
  Future<Response<Object?>> fetchAlbumPhotos(int albumId, {int limit = 3}) => _dio.get<Object?>(
        'https://jsonplaceholder.typicode.com/photos',
        queryParameters: {'albumId': albumId, '_limit': limit},
      );
}
