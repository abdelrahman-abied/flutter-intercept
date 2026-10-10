import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseApiFile } from '../../src/contract/api';
import { tokenize } from '../../src/contract/dart';
import { describeType, modelNameFromFn, parseGeneratedDart, XModel } from '../../src/contract/generated';
import { LinkedModel, linkModelsToOwner } from '../../src/contract/owner';

const FIX = path.join(__dirname, 'fixtures', 'contract');
const DEMO = path.join(__dirname, '..', '..', '..', '..', 'samples', 'demo_app', 'lib');

function load(gen: string, owner?: string): LinkedModel[] {
  const info = parseGeneratedDart(fs.readFileSync(gen, 'utf8'), gen);
  if (owner) linkModelsToOwner(info.models, fs.readFileSync(owner, 'utf8'), owner);
  return info.models as LinkedModel[];
}

const byName = (models: XModel[], name: string) => {
  const m = models.find((x) => x.name === name);
  if (!m) throw new Error(`no model ${name} in ${models.map((x) => x.name).join(', ')}`);
  return m;
};
const field = (m: XModel, dartName: string) => {
  const f = m.fields.find((x) => x.dartName === dartName);
  if (!f) throw new Error(`no field ${dartName} in ${m.name}: ${m.fields.map((x) => x.dartName).join(', ')}`);
  return f;
};

describe('modelNameFromFn', () => {
  it('normalises json_serializable and every freezed naming', () => {
    expect(modelNameFromFn('_$UserFromJson')).toBe('User');
    expect(modelNameFromFn('_$$UserImplFromJson')).toBe('User'); // freezed 2.4–2.5
    expect(modelNameFromFn('_$$_UserFromJson')).toBe('User'); // freezed 2.0–2.3
    expect(modelNameFromFn('_$_$_UserFromJson')).toBe('User'); // freezed 0.x/1.x
    expect(modelNameFromFn('_$ImplFromJson')).toBe('Impl'); // a class really named Impl
    expect(modelNameFromFn('fromJson')).toBeUndefined();
  });
});

describe('real json_serializable output (demo app, json_serializable 6.x)', () => {
  const models = load(path.join(DEMO, 'models', 'user.g.dart'), path.join(DEMO, 'models', 'user.dart'));

  it('reads renamed keys, nullability, nested models, lenient enums with defaults', () => {
    const user = byName(models, 'User');
    expect(user.sourceFile).toBe(path.join(DEMO, 'models', 'user.dart'));
    expect(field(user, 'handle')).toMatchObject({ key: 'username', type: { kind: 'string' }, nullable: false, hasDefault: false });
    expect(field(user, 'id').type).toEqual({ kind: 'int' }); // (as num).toInt(): lenient
    expect(field(user, 'avatarUrl')).toMatchObject({ key: 'avatar_url', nullable: true });
    expect(field(user, 'address').type).toEqual({ kind: 'model', name: 'Address' });
    expect(field(user, 'tier')).toMatchObject({
      type: { kind: 'enum', name: 'UserTier', values: ['free', 'pro', 'unknown'], lenient: true, fallback: 'UserTier.unknown' },
      nullable: true,
      hasDefault: true,
    });
    expect(field(byName(models, 'Address'), 'zipCode').key).toBe('zipcode');
  });

  it('links field declarations to lines and columns in the owner', () => {
    const user = byName(models, 'User') as LinkedModel;
    const src = fs.readFileSync(path.join(DEMO, 'models', 'user.dart'), 'utf8').split('\n');
    expect(src[user.sourceLine! - 1]).toMatch(/^class User\b/);
    for (const f of user.fields) {
      const line = src[user.fieldLines![f.dartName] - 1];
      expect(line.slice(user.fieldColumns![f.dartName])).toMatch(new RegExp(`^${f.dartName}\\b`));
    }
  });
});

describe('real output: every json_serializable shape (probe/models.g.dart)', () => {
  const models = load(path.join(FIX, 'probe', 'models.g.dart'), path.join(FIX, 'probe', 'models.dart'));
  const p = byName(models, 'Profile');

  it('maps conversions to wire types', () => {
    const t = (n: string) => field(p, n).type;
    expect(t('createdAt')).toEqual({ kind: 'datetime' });
    expect(field(p, 'website')).toMatchObject({ type: { kind: 'uri' }, nullable: true });
    expect(t('score')).toEqual({ kind: 'double' });
    expect(field(p, 'ratio')).toMatchObject({ type: { kind: 'double' }, nullable: true });
    expect(field(p, 'count')).toMatchObject({ type: { kind: 'int' }, hasDefault: true });
    expect(t('tags')).toEqual({ kind: 'list', of: { kind: 'string' }, elemNullable: false });
    expect(describeType(t('matrix'))).toBe('List<List<double>>');
    expect(t('items')).toEqual({ kind: 'list', of: { kind: 'model', name: 'Item' }, elemNullable: false });
    expect(t('byId')).toEqual({ kind: 'map', of: { kind: 'model', name: 'Item' }, elemNullable: false });
    expect(field(p, 'optionalItems').nullable).toBe(true);
    expect(field(p, 'role')).toMatchObject({ type: { kind: 'enum', values: ['admin', 'user'] }, nullable: false });
    expect(field(p, 'maybeRole').nullable).toBe(true);
    expect(t('big')).toEqual({ kind: 'bigint' });
    expect(t('duration')).toEqual({ kind: 'int' });
    expect(t('extra')).toMatchObject({ kind: 'map', of: { kind: 'dynamic' } });
    expect(t('epoch')).toMatchObject({ kind: 'unknown' }); // JsonConverter
    expect(field(p, 'status')).toMatchObject({ type: { kind: 'enum', jsonValues: ['active', 2], unknownToNull: true }, nullable: true });
    expect(field(p, 'maybeNested')).toMatchObject({ type: { kind: 'model', name: 'Item' }, nullable: true });
    expect(t('namesById')).toEqual({ kind: 'map', of: { kind: 'string' }, elemNullable: false });
    expect(field(p, 'anything')).toMatchObject({ type: { kind: 'dynamic' }, nullable: true });
    expect(t('setOf')).toMatchObject({ kind: 'list', of: { kind: 'string' } });
    expect(p.fields.find((f) => f.dartName === 'ignored')).toBeUndefined();
  });

  it('names positional arguments from the owner constructor (fieldRename)', () => {
    expect(p.fields.slice(0, 3).map((f) => [f.dartName, f.key])).toEqual([
      ['firstName', 'first_name'],
      ['lastName', 'surname'],
      ['createdAt', 'created_at'],
    ]);
    expect(p.fieldLines?.lastName).toBeGreaterThan(p.sourceLine!);
  });

  it('reads checked: true ($checkedCreate) with $checkKeys', () => {
    const item = byName(models, 'Item');
    expect(item.checked).toBe(true);
    expect(field(item, 'itemId').key).toBe('item-id');
    expect(field(item, 'label')).toMatchObject({ requiredKey: true, disallowNull: true, nullable: false });
    expect(field(item, 'qty')).toMatchObject({ hasDefault: true });
    expect(field(item, 'price').type).toEqual({ kind: 'num' });
  });

  it('keeps generic fields unknown and skips json_serializable helpers', () => {
    const page = byName(models, 'Page');
    expect(page.typeParams).toEqual(['T']);
    expect(field(page, 'data').type).toMatchObject({ kind: 'list', of: { kind: 'unknown' } });
    expect(field(page, 'next').type.kind).toBe('unknown');
    expect(models.map((m) => m.name)).not.toContain('nullableGeneric');
  });

  it('reads pascal / screaming-snake keys and anyMap', () => {
    expect(byName(models, 'Pascal').fields.map((f) => f.key)).toEqual(['SomeValue', 'When']);
    expect(field(byName(models, 'Screaming'), 'nested')).toMatchObject({ key: 'NESTED', type: { kind: 'model', name: 'Item' } });
  });
});

describe('freezed', () => {
  it('reads freezed 3 output (real) and links to the freezed class', () => {
    const models = load(path.join(FIX, 'probe', 'frozen.g.dart'), path.join(FIX, 'probe', 'frozen.dart'));
    const person = byName(models, 'Person');
    expect(person.constructed).toBe('_Person');
    expect(person.sourceLine).toBe(7);
    expect(field(person, 'avatarUrl')).toMatchObject({ key: 'avatar_url', nullable: true });
    expect(field(person, 'age')).toMatchObject({ hasDefault: true });
    expect(field(person, 'nicknames')).toMatchObject({ hasDefault: true, type: { kind: 'list' } });
    expect(person.fieldLines?.pet).toBe(13);
    // union cases: linked through `= Circle;`
    const circle = byName(models, 'Circle');
    expect(circle.sourceLine).toBe(27);
    expect(field(circle, 'radius').type).toEqual({ kind: 'double' });
  });

  it('reads the older freezed namings (hand-written fixture)', () => {
    const models = load(path.join(FIX, 'legacy', 'freezed_old.g.dart'), path.join(FIX, 'legacy', 'freezed_old.dart'));
    expect(models.map((m) => m.name)).toEqual(['Legacy', 'Middle', 'Recent']);
    expect(byName(models, 'Middle').sourceLine).toBe(12);
    expect(field(byName(models, 'Middle'), 'count').type).toEqual({ kind: 'int', strict: true });
    const r = byName(models, 'Recent');
    expect(field(r, 'label')).toMatchObject({ nullable: true, hasDefault: true });
    expect(field(r, 'values').type).toMatchObject({ kind: 'list', of: { kind: 'int' } });
    expect(field(r, 'matrix').type).toMatchObject({ kind: 'list', of: { kind: 'list', of: { kind: 'string' }, elemNullable: true } });
    expect(field(r, 'createdAt').type.kind).toBe('unknown');
    expect(field(r, 'mapped').type.kind).toBe('unknown'); // _$JsonConverterFromJson
    expect(field(r, 'extra').type.kind).toBe('unknown'); // readValue
    expect(field(r, 'level')).toMatchObject({ type: { kind: 'enum', jsonValues: [1, 2, 'other'], lenient: true }, hasDefault: true });
  });
});

describe('older json_serializable output (hand-written fixtures)', () => {
  it('reads 4.x–6.7 shapes: strict `as int`, cascades, `?? default`', () => {
    const models = load(path.join(FIX, 'legacy', 'order.g.dart'), path.join(FIX, 'legacy', 'order.dart'));
    const o = byName(models, 'Order');
    expect(o.fields.map((f) => f.dartName)).toEqual(['orderId', 'total', 'placedAt', 'quantity', 'note', 'state', 'items']);
    expect(field(o, 'orderId').type).toEqual({ kind: 'int', strict: true });
    expect(field(o, 'quantity')).toMatchObject({ type: { kind: 'int', strict: true }, nullable: true });
    expect(field(o, 'note')).toMatchObject({ hasDefault: true });
    expect(field(o, 'state')).toMatchObject({ type: { kind: 'enum', name: 'OrderState' }, nullable: false });
    expect(field(o, 'items')).toMatchObject({ type: { kind: 'list', of: { kind: 'model', name: 'LineItem' } }, nullable: true });
    expect(o.fieldLines?.note).toBe(16);
  });

  it('reads 3.x block bodies, legacy $checkedNew and legacy enum helpers', () => {
    const models = load(path.join(FIX, 'legacy', 'v3.g.dart'), path.join(FIX, 'legacy', 'v3.dart'));
    expect(models.map((m) => m.name)).toEqual(['Account', 'Person']);
    const a = byName(models, 'Account');
    expect(field(a, 'id')).toMatchObject({ requiredKey: true, type: { kind: 'int', strict: true } });
    expect(field(a, 'owner')).toMatchObject({ type: { kind: 'model', name: 'Person' }, nullable: true });
    expect(field(a, 'kind')).toMatchObject({ type: { kind: 'enum', name: 'Kind' }, nullable: true });
    expect(field(a, 'scores').type).toMatchObject({ kind: 'map', of: { kind: 'double' } });
    const p = byName(models, 'Person');
    expect(p.checked).toBe(true);
    expect(field(p, 'fullName').key).toBe('full_name');
    expect(field(p, 'age').type).toEqual({ kind: 'int', strict: true });
  });

  it('degrades unreadable arguments and truncated functions instead of throwing', () => {
    const models = load(path.join(FIX, 'legacy', 'broken.g.dart'));
    const w = byName(models, 'Weird');
    expect(field(w, 'a').type).toEqual({ kind: 'string' });
    expect(field(w, 'e').type).toEqual({ kind: 'double' });
    expect(w.fields.every((f) => f.type.kind !== 'unknown' || f.nullable)).toBe(true);
  });
});

describe('never throws', () => {
  const files = [
    path.join(DEMO, 'models', 'user.g.dart'),
    path.join(DEMO, 'api', 'users_api.g.dart'),
    ...['models.g.dart', 'frozen.g.dart', 'chop.chopper.dart', 'models.dart', 'chop.dart'].map((f) => path.join(FIX, 'probe', f)),
    ...['order.g.dart', 'v3.g.dart', 'freezed_old.g.dart', 'broken.g.dart'].map((f) => path.join(FIX, 'legacy', f)),
  ];
  it('on every prefix / random slice / random edit of the fixtures', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % Math.max(1, n);
    };
    const junk = ['(', ')', '{', '}', "'", '"', '<', '>', '?', '..', '=>', '/*', 'r"', '${', '\\', '@', ''];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (let k = 0; k < 60; k++) {
        const a = rnd(text.length);
        const variants = [
          text.slice(0, a),
          text.slice(a, a + rnd(400)),
          text.slice(0, a) + junk[rnd(junk.length)] + text.slice(a + rnd(5)),
        ];
        for (const v of variants) {
          expect(() => parseGeneratedDart(v, f)).not.toThrow();
          expect(() => linkModelsToOwner(parseGeneratedDart(v, f).models, v, f)).not.toThrow();
          expect(() => parseApiFile(v, f)).not.toThrow();
        }
      }
    }
    expect(() => tokenize('"unterminated')).not.toThrow();
    expect(parseGeneratedDart('', 'x.g.dart').models).toEqual([]);
    expect(parseGeneratedDart('X _$XFromJson(Map<String, dynamic> json) => X(' + '('.repeat(5000), 'x.g.dart').models.length).toBeLessThanOrEqual(1);
  });
});

describe('Retrofit / Chopper declarations', () => {
  it('reads the demo Retrofit API (real) and its generated class', () => {
    const file = path.join(DEMO, 'api', 'users_api.dart');
    const eps = parseApiFile(fs.readFileSync(file, 'utf8'), file);
    expect(eps.map((e) => [e.method, e.pathTemplate, e.dartMethod, e.responseModel, !!e.responseIsList])).toEqual([
      ['GET', '/users/{id}', 'getUser', 'User', false], // HttpResponse<User>
      ['GET', '/users/{id}/todos', 'getTodos', 'Todo', true],
    ]);
    expect(eps[0]).toMatchObject({ baseUrl: 'https://jsonplaceholder.typicode.com', apiClass: 'UsersApi', kind: 'retrofit', line: 15 });
    const gen = parseGeneratedDart(fs.readFileSync(path.join(DEMO, 'api', 'users_api.g.dart'), 'utf8'), 'users_api.g.dart');
    expect(gen.apiClasses).toEqual([{ generated: '_UsersApi', api: 'UsersApi', kind: 'retrofit', line: 14 }]);
    expect(gen.models).toEqual([]);
  });

  it('reads Chopper (real generated class, base path joined)', () => {
    const file = path.join(FIX, 'probe', 'chop.dart');
    const eps = parseApiFile(fs.readFileSync(file, 'utf8'), file);
    expect(eps.map((e) => [e.method, e.pathTemplate, e.responseModel, !!e.responseIsList])).toEqual([
      ['GET', '/items/{id}', 'Item', false],
      ['GET', '/items', 'Item', true],
      ['POST', '/items/', 'Item', false],
    ]);
    const gen = parseGeneratedDart(fs.readFileSync(path.join(FIX, 'probe', 'chop.chopper.dart'), 'utf8'), 'chop.chopper.dart');
    expect(gen.apiClasses).toMatchObject([{ generated: '_$ItemService', api: 'ItemService', kind: 'chopper' }]);
  });

  it('reads base paths, absolute paths, wrappers and non-model returns', () => {
    const src = `
import 'package:retrofit/retrofit.dart';
part 'shop_api.g.dart';

@RestApi(baseUrl: 'https://api.example.com/v1/')
abstract class ShopApi {
  factory ShopApi(Dio dio, {String? baseUrl}) = _ShopApi;

  @GET('/users')
  Future<List<User>> users(@Query('page') int page);

  @GET('/users/me')
  @Headers(<String, dynamic>{'Accept': 'application/json'})
  Future<HttpResponse<User>> me();

  @GET('/users/{id}')
  Future<User?> user(@Path() String id);

  @DELETE('/users/{id}')
  Future<void> remove(@Path() String id);

  @GET('https://cdn.example.com/x/{id}')
  Future<Map<String, dynamic>> raw(@Path() String id);

  @POST('/search?sort=asc')
  Future<Page<User>> search(@Body() Map<String, dynamic> body);

  @GET('/names')
  Future<List<String>> names();
}

@RestApi()
abstract class NoBase {
  @PATCH('things/{id}')
  Future<Thing> patch(@Path() int id, @Body() Thing body);
}
`;
    const eps = parseApiFile(src, '/w/lib/shop_api.dart');
    const row = (n: string) => eps.find((e) => e.dartMethod === n)!;
    expect(row('users')).toMatchObject({ method: 'GET', pathTemplate: '/v1/users', baseUrl: 'https://api.example.com/v1/', responseModel: 'User', responseIsList: true });
    expect(row('me')).toMatchObject({ pathTemplate: '/v1/users/me', responseModel: 'User' });
    expect(row('user')).toMatchObject({ pathTemplate: '/v1/users/{id}', responseModel: 'User' });
    expect(row('remove').responseModel).toBeUndefined();
    expect(row('raw')).toMatchObject({ pathTemplate: '/x/{id}', baseUrl: 'https://cdn.example.com' });
    expect(row('raw').responseModel).toBeUndefined();
    expect(row('search')).toMatchObject({ method: 'POST', pathTemplate: '/v1/search', responseModel: 'Page' });
    expect(row('names').responseModel).toBeUndefined();
    expect(row('patch')).toMatchObject({ method: 'PATCH', pathTemplate: '/things/{id}', responseModel: 'Thing', apiClass: 'NoBase' });
    expect(row('patch').baseUrl).toBeUndefined();
  });

  it('reads className, returnType and params (kinds, keys, named) for fixture generators', () => {
    const src = `
@RestApi(baseUrl: 'https://api.example.com')
abstract class ShopApi {
  @GET('/users/{id}/orders')
  Future<HttpResponse<List<Order>>> orders(
    @Path('id') int userId,
    @Query('page') int page, {
    @Query('sort') String? sort,
    @Header('X-Trace') required String trace,
    @CancelRequest() CancelToken? cancel,
  });

  @POST('/orders')
  @FormUrlEncoded()
  Future<Order> create(@Body() Order body, @Field() String note, @Queries() Map<String, dynamic> q);
}

@ChopperApi(baseUrl: '/items')
abstract class ItemService extends ChopperService {
  @Get(path: '/{id}')
  Future<Response<Item>> getItem(@Path() String id, [@Query('v') int? version]);
}`;
    const eps = parseApiFile(src, '/w/lib/shop.dart');
    const orders = eps.find((e) => e.dartMethod === 'orders')!;
    expect(orders.className).toBe('ShopApi');
    expect(orders.returnType).toBe('Future<HttpResponse<List<Order>>>');
    expect(orders.params).toEqual([
      { name: 'userId', type: 'int', kind: 'path', key: 'id' },
      { name: 'page', type: 'int', kind: 'query' },
      { name: 'sort', type: 'String?', kind: 'query', named: true },
      { name: 'trace', type: 'String', kind: 'header', key: 'X-Trace', named: true },
      { name: 'cancel', type: 'CancelToken?', kind: 'other', named: true },
    ]);
    expect(eps.find((e) => e.dartMethod === 'create')!.params).toEqual([
      { name: 'body', type: 'Order', kind: 'body' },
      { name: 'note', type: 'String', kind: 'field' },
      { name: 'q', type: 'Map<String, dynamic>', kind: 'query' },
    ]);
    const item = eps.find((e) => e.dartMethod === 'getItem')!;
    expect(item).toMatchObject({ className: 'ItemService', returnType: 'Future<Response<Item>>' });
    expect(item.params).toEqual([
      { name: 'id', type: 'String', kind: 'path' },
      { name: 'version', type: 'int?', kind: 'query', key: 'v' },
    ]);
  });
});
