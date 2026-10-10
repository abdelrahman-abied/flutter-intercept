import { describe, expect, it } from 'vitest';
import { dartTypeName, inferSchema, type ClassDef, type Schema } from '../../src/codegen/infer';
import { JsonDouble, isJson, parseJsonSample, prettyJson } from '../../src/codegen/json';
import { camelCase, className, fieldName, itemClassName, pascalCase, singularWord, snakeCase, words } from '../../src/codegen/naming';

const cls = (s: Schema, name: string): ClassDef => {
  const c = s.classes.find((x) => x.name === name);
  if (!c) throw new Error(`no class ${name} in ${s.classes.map((x) => x.name).join(', ')}`);
  return c;
};
/** "name: Type" per field, with markers: ~ optional, ! nullable. */
const fields = (c: ClassDef) => c.fields.map((f) => `${f.name}${f.optional ? '~' : ''}${f.nullable ? '!' : ''}: ${dartTypeName(f.type)}`);
const schema = (samples: string[], root = 'User') => inferSchema(samples.map(parseJsonSample), root);

describe('parseJsonSample', () => {
  it('parses like JSON.parse, keeping doubles that look like ints', () => {
    const v = parseJsonSample('{"a":1,"b":1.0,"c":2.5,"d":1e3,"e":-0,"f":[true,null,"x\\n\\u00e9"],"g":{}}') as Record<string, unknown>;
    expect(v.a).toBe(1);
    expect(v.b).toBeInstanceOf(JsonDouble);
    expect((v.b as JsonDouble).value).toBe(1);
    expect(v.c).toBeInstanceOf(JsonDouble);
    expect(v.d).toBeInstanceOf(JsonDouble);
    expect(v.e).toBe(-0);
    expect(v.f).toEqual([true, null, 'x\né']);
    expect(v.g).toEqual({});
    expect(JSON.stringify(v)).toBe('{"a":1,"b":1,"c":2.5,"d":1000,"e":0,"f":[true,null,"x\\né"],"g":{}}');
  });

  it('treats integers beyond int64 as doubles (like Dart) and keeps __proto__ as a plain key', () => {
    const v = parseJsonSample('{"big":12345678901234567890,"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(v.big).toBeInstanceOf(JsonDouble);
    expect(Object.keys(v)).toEqual(['big', '__proto__']);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });

  it.each(['', '{', '{"a":}', '[1,]', '01', '"\\x"', '{"a":1} x', "{'a':1}", 'NaN', '"a\nb"'])('rejects %j', (t) => {
    expect(() => parseJsonSample(t)).toThrow(SyntaxError);
    expect(isJson(t)).toBe(false);
  });
});

describe('prettyJson', () => {
  it('re-indents without touching literals', () => {
    expect(prettyJson('{"a":1.0,"b":[],"c":{},"d":[1,{"e":"x, y: [z]"}],"t":"[redacted]"}')).toBe(
      ['{', '  "a": 1.0,', '  "b": [],', '  "c": {},', '  "d": [', '    1,', '    {', '      "e": "x, y: [z]"', '    }', '  ],', '  "t": "[redacted]"', '}'].join('\n'),
    );
    expect(prettyJson(' [ ] ')).toBe('[]');
    expect(prettyJson('"s"')).toBe('"s"');
    expect(prettyJson('{"q":"a\\"b"}')).toBe('{\n  "q": "a\\"b"\n}');
  });
  it('throws on invalid JSON', () => {
    expect(() => prettyJson('{"a":')).toThrow();
  });
});

describe('naming', () => {
  it('splits keys into words', () => {
    expect(words('avatar_url')).toEqual(['avatar', 'url']);
    expect(words('avatarURL')).toEqual(['avatar', 'URL']);
    expect(words('HTTPStatusCode')).toEqual(['HTTP', 'Status', 'Code']);
    expect(words('user-id.v2')).toEqual(['user', 'id', 'v2']);
    expect(words('@type')).toEqual(['type']);
  });

  it('makes camel, pascal and snake case', () => {
    expect(camelCase('avatar_url')).toBe('avatarUrl');
    expect(camelCase('AvatarURL')).toBe('avatarUrl');
    expect(camelCase('ID')).toBe('id');
    expect(pascalCase('order_items')).toBe('OrderItems');
    expect(snakeCase('UserProfile')).toBe('user_profile');
    expect(snakeCase('HTTPResponse')).toBe('http_response');
  });

  it('sanitises field names: reserved words, leading digits, symbols, members of every model', () => {
    expect(fieldName('class')).toBe('classValue');
    expect(fieldName('default')).toBe('defaultValue');
    expect(fieldName('is')).toBe('isValue');
    expect(fieldName('hashCode')).toBe('hashCodeValue');
    expect(fieldName('toJson')).toBe('toJsonValue');
    expect(fieldName('int')).toBe('intValue');
    expect(fieldName('2fa_enabled')).toBe('field2faEnabled');
    expect(fieldName('$ref')).toBe('ref');
    expect(fieldName('_id')).toBe('id');
    expect(fieldName('名前')).toBe('field');
    expect(fieldName('')).toBe('field');
    expect(fieldName('type')).toBe('type');
    expect(fieldName('async')).toBe('async');
  });

  it('singularises list item names', () => {
    const cases: Record<string, string | undefined> = {
      items: 'item',
      users: 'user',
      categories: 'category',
      addresses: 'address',
      boxes: 'box',
      matches: 'match',
      statuses: 'status',
      responses: 'response',
      movies: 'movie',
      people: 'person',
      children: 'child',
      data: undefined,
      news: undefined,
      address: undefined,
      analysis: undefined,
    };
    for (const [plural, single] of Object.entries(cases)) expect(singularWord(plural), plural).toBe(single);
    expect(itemClassName('items')).toBe('Item');
    expect(itemClassName('order_items')).toBe('OrderItem');
    expect(itemClassName('categories')).toBe('Category');
    expect(itemClassName('data')).toBe('DataItem');
    expect(itemClassName('3d_models')).toBe('Item3dModel');
    expect(className('user-profile')).toBe('UserProfile');
  });
});

describe('inferSchema', () => {
  it('separates optional (missing somewhere) from nullable (null somewhere)', () => {
    const s = schema(['{"id":1,"name":"a","bio":"x","nick":null}', '{"id":2,"name":null}']);
    expect(fields(cls(s, 'User'))).toEqual(['id: int', 'name!: String?', 'bio~: String?', 'nick~!: dynamic']);
  });

  it('widens int + double to double, else mixed types become dynamic', () => {
    const s = schema(['{"a":1,"b":1,"c":"x","d":true}', '{"a":2.5,"b":"1","c":1,"d":false}']);
    expect(fields(cls(s, 'User'))).toEqual(['a: double', 'b: dynamic', 'c: dynamic', 'd: bool']);
  });

  it('reads 1.0 from parseJsonSample as a double', () => {
    expect(fields(cls(schema(['{"price":1.0}']), 'User'))).toEqual(['price: double']);
    expect(fields(inferSchema([{ price: 1 }], 'User').classes[0])).toEqual(['price: int']);
  });

  it('types empty lists as List<dynamic> unless another sample fills them', () => {
    const s = schema(['{"a":[],"b":[],"c":[[]]}', '{"a":["x"],"b":[],"c":[[1.5, null]]}']);
    expect(fields(cls(s, 'User'))).toEqual(['a: List<String>', 'b: List<dynamic>', 'c: List<List<double?>>']);
  });

  it('merges the objects of an array (optional fields across elements) and names the item class singular', () => {
    const s = schema(['{"items":[{"sku":"a","qty":1},{"sku":"b","qty":2,"note":"n"}],"categories":[{"id":1}]}']);
    expect(s.classes.map((c) => c.name)).toEqual(['User', 'Item', 'Category']);
    expect(fields(cls(s, 'User'))).toEqual(['items: List<Item>', 'categories: List<Category>']);
    expect(fields(cls(s, 'Item'))).toEqual(['sku: String', 'qty: int', 'note~: String?']);
  });

  it('marks list elements nullable when an element is null', () => {
    expect(fields(cls(schema(['{"r":[1,null],"o":[{"a":1},null]}']), 'User'))).toEqual(['r: List<int?>', 'o: List<OItem?>']);
  });

  it('handles top-level lists (and lists of lists) of objects', () => {
    const s = schema(['[{"id":1},{"id":2,"x":true}]', '[]'], 'post');
    expect(s.rootName).toBe('Post');
    expect(dartTypeName(s.rootType)).toBe('List<Post>');
    expect(fields(s.classes[0])).toEqual(['id: int', 'x~: bool?']);
    expect(dartTypeName(schema(['[[{"a":1}]]'], 'Cell').rootType)).toBe('List<List<Cell>>');
  });

  it('models objects keyed by ids as maps', () => {
    const s = schema(['{"by_id":{"17":{"t":"x"},"42":{"t":"y","d":true}}}']);
    expect(fields(cls(s, 'User'))).toEqual(['byId: Map<String, ByIdItem>']);
    expect(fields(cls(s, 'ByIdItem'))).toEqual(['t: String', 'd~: bool?']);
    const root = schema(['{"550e8400-e29b-41d4-a716-446655440000":{"n":1}}'], 'Thing');
    expect(dartTypeName(root.rootType)).toBe('Map<String, Thing>');
  });

  it('keeps first-seen field order across samples', () => {
    const s = schema(['{"b":1,"a":1}', '{"c":1,"a":1,"b":1}']);
    expect(cls(s, 'User').fields.map((f) => f.key)).toEqual(['b', 'a', 'c']);
  });

  it('de-duplicates field names, letting a key that is already the Dart name keep it', () => {
    const s = schema(['{"@type":"x","type":"y","user_id":1,"userId":2,"user-id":3}']);
    expect(cls(s, 'User').fields.map((f) => `${f.key}=${f.name}`)).toEqual(['@type=type2', 'type=type', 'user_id=userId2', 'userId=userId', 'user-id=userId3']);
  });

  it('names nested classes, avoiding dart:core names, the root name and collisions', () => {
    const s = schema(['{"type":{"a":1},"user":{"b":1},"address":{"c":1},"billing":{"address":{"d":1}},"list":{"e":1}}']);
    expect(s.classes.map((c) => c.name)).toEqual(['User', 'UserType', 'UserUser', 'Address', 'Billing', 'BillingAddress', 'UserList']);
  });

  it('reuses one class for identical shapes under the same name', () => {
    const s = schema(['{"author":{"id":1,"name":"a"},"comments":[{"author":{"id":2,"name":"b"}}]}']);
    expect(s.classes.map((c) => c.name)).toEqual(['User', 'Author', 'Comment']);
    expect(fields(cls(s, 'Comment'))).toEqual(['author: Author']);
  });

  it('sanitises the root name', () => {
    expect(schema(['{}'], 'list').rootName).toBe('ListModel');
    expect(schema(['{}'], 'get users').rootName).toBe('GetUsers');
    expect(schema(['{}'], '').rootName).toBe('Response');
  });

  it('refuses samples without an object to model', () => {
    expect(() => inferSchema([], 'X')).toThrow(/No samples/);
    expect(() => schema(['"text"'])).toThrow(/a string/);
    expect(() => schema(['[]'])).toThrow(/only empty lists/);
    expect(() => schema(['{"a":1}', '[{"a":1}]'])).toThrow(/different types/);
    expect(() => schema(['null'])).toThrow(/null/);
  });
});
