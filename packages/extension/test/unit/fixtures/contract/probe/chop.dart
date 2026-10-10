import 'package:chopper/chopper.dart';
import 'models.dart';

part 'chop.chopper.dart';

@ChopperApi(baseUrl: '/items')
abstract class ItemService extends ChopperService {
  static ItemService create([ChopperClient? client]) => _$ItemService(client);

  @GET(path: '/{id}')
  Future<Response<Item>> getItem(@Path() String id);

  @Get(path: '')
  Future<Response<List<Item>>> list({@Query('page') int page = 1});

  @Post(path: '/')
  Future<Response<Item>> create(@Body() Map<String, dynamic> body);
}
