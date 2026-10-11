import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GrpcSchema, isGrpcGeneratedFile, loadGrpcSchema, ProtoMessage } from '../../../src/grpc';
import { FIX, readGenerated, VERSIONS } from './helpers';

const load = (v: string) => loadGrpcSchema(readGenerated(path.join(FIX, v)));

/** The schema without file paths / lines, for comparing protoc_plugin versions. */
function shape(s: GrpcSchema) {
  const msgs = [...s.messages]
    .map((m) => ({ name: m.name, dartClass: m.dartClass, fields: m.fields }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const methods = [...s.methods]
    .map(({ path: p, requestType, responseType, clientStreaming, serverStreaming }) => ({ p, requestType, responseType, clientStreaming, serverStreaming }))
    .sort((a, b) => a.p.localeCompare(b.p));
  const enums = ['fi.shop.v1.Color', 'fi.shop.v1.Order.Line.Kind', 'fi.common.Level', 'fi.legacy.Legacy.Kind', 'google.protobuf.NullValue'].map((n) => {
    const e = s.enumType(n);
    return e && { name: e.name, dartClass: e.dartClass, values: e.values };
  });
  return { msgs, methods, enums };
}

const field = (m: ProtoMessage | undefined, name: string) => {
  const f = m?.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name} in ${m?.name}: ${m?.fields.map((x) => x.name).join(', ')}`);
  return f;
};

describe('isGrpcGeneratedFile', () => {
  it('selects pb / pbenum / pbgrpc, not pbjson / pbserver or other Dart', () => {
    expect(isGrpcGeneratedFile('/a/lib/src/gen/shop.pb.dart')).toBe(true);
    expect(isGrpcGeneratedFile('C:\\app\\lib\\shop.pbenum.dart')).toBe(true);
    expect(isGrpcGeneratedFile('shop.pbgrpc.dart')).toBe(true);
    expect(isGrpcGeneratedFile('shop.pbjson.dart')).toBe(false);
    expect(isGrpcGeneratedFile('shop.pbserver.dart')).toBe(false);
    expect(isGrpcGeneratedFile('shop.g.dart')).toBe(false);
    expect(isGrpcGeneratedFile('shop.proto')).toBe(false);
  });
});

describe.each(VERSIONS)('protoc_plugin %s output', (v) => {
  const s = load(v);

  it('loads without problems', () => {
    expect(s.problems).toEqual([]);
  });

  it('reads every method with its types and streaming', () => {
    const m = (p: string) => {
      const x = s.method(p);
      return x && [x.requestType, x.responseType, x.clientStreaming, x.serverStreaming];
    };
    expect(m('/fi.shop.v1.ShopService/GetOrder')).toEqual(['fi.shop.v1.GetOrderRequest', 'fi.shop.v1.Order', false, false]);
    expect(m('/fi.shop.v1.ShopService/WatchOrders')).toEqual(['fi.shop.v1.GetOrderRequest', 'fi.shop.v1.Order', false, true]);
    expect(m('/fi.shop.v1.ShopService/UploadLines')).toEqual(['fi.shop.v1.Order.Line', 'fi.shop.v1.Order', true, false]);
    expect(m('/fi.shop.v1.ShopService/Chat')).toEqual(['fi.shop.v1.Scalars', 'fi.shop.v1.Scalars', true, true]);
    expect(m('/fi.shop.v1.ShopService/Ping')).toEqual(['google.protobuf.Empty', 'google.protobuf.Empty', false, false]);
    expect(m('/fi.shop.v1.ShopService/Nested')).toEqual(['fi.shop.v1.Outer', 'fi.common.Money', false, false]);
    expect(m('/fi.legacy.LegacyService/Process')).toEqual(['fi.legacy.Legacy', 'fi.legacy.Legacy', false, false]);
    expect(m('/NoPkg/Echo')).toEqual(['Bare', 'Bare', false, false]);
    expect(s.methods).toHaveLength(8);
    const get = s.method('/fi.shop.v1.ShopService/GetOrder')!;
    expect(get.file.endsWith('shop.pbgrpc.dart')).toBe(true);
    expect(get.line).toBeGreaterThan(1);
  });

  it('maps Dart classes to fully-qualified names, nested and escaped ones included', () => {
    const names = (c: string) => s.messages.find((m) => m.dartClass === c)?.name;
    expect(names('Order_Line')).toBe('fi.shop.v1.Order.Line');
    expect(names('Order_Line_Note')).toBe('fi.shop.v1.Order.Line.Note');
    expect(names('Outer_Inner')).toBe('fi.shop.v1.Outer_Inner'); // a top-level message named Outer_Inner
    expect(names('Outer_Inner_')).toBe('fi.shop.v1.Outer.Inner'); // the nested one, renamed by protoc_plugin
    expect(names('List_')).toBe('fi.shop.v1.List');
    expect(names('Legacy_Sub')).toBe('fi.legacy.Legacy.Sub');
    expect(names('Bare')).toBe('Bare');
    const outer = s.message('fi.shop.v1.Outer');
    expect(outer?.fields.map((f) => [f.name, f.type])).toEqual([
      ['inner', { kind: 'message', type: 'fi.shop.v1.Outer.Inner' }],
      ['flat', { kind: 'message', type: 'fi.shop.v1.Outer_Inner' }],
      ['list', { kind: 'message', type: 'fi.shop.v1.List' }],
    ]);
    expect(s.message('.fi.shop.v1.Outer')).toBe(outer);
    expect(s.message('type.googleapis.com/fi.shop.v1.Outer')).toBe(outer);
  });

  it('reads every scalar type and label', () => {
    const sc = s.message('fi.shop.v1.Scalars');
    expect(sc?.fields.map((f) => [f.number, f.name, f.type.kind === 'scalar' ? f.type.scalar : f.type])).toEqual([
      [1, 'd', 'double'],
      [2, 'f', 'float'],
      [3, 'i32', 'int32'],
      [4, 'i64', 'int64'],
      [5, 'u32', 'uint32'],
      [6, 'u64', 'uint64'],
      [7, 's32', 'sint32'],
      [8, 's64', 'sint64'],
      [9, 'fx32', 'fixed32'],
      [10, 'fx64', 'fixed64'],
      [11, 'sfx32', 'sfixed32'],
      [12, 'sfx64', 'sfixed64'],
      [13, 'b', 'bool'],
      [14, 's', 'string'],
      [15, 'by', 'bytes'],
      [16, 'optI32', 'int32'],
      [17, 'optS', 'string'],
      [18, 'color', { kind: 'enum', type: 'fi.shop.v1.Color' }],
    ]);
    const rep = s.message('fi.shop.v1.Repeats')!;
    expect(rep.fields.every((f) => f.repeated)).toBe(true);
    expect(field(rep, 'i32').packed).toBe(true);
    expect(field(rep, 'colors').packed).toBe(true);
    expect(field(rep, 's').packed).toBeUndefined();
    expect(field(rep, 'unpacked').packed).toBeUndefined();
    expect(field(rep, 'moneys').type).toEqual({ kind: 'message', type: 'fi.common.Money' });
  });

  it('reads maps, oneofs, json names, imports and well-known types', () => {
    const o = s.message('fi.shop.v1.Order')!;
    expect(field(o, 'labels').type).toEqual({ kind: 'map', key: 'string', value: { kind: 'scalar', scalar: 'string' } });
    expect(field(o, 'linesByNo').type).toEqual({ kind: 'map', key: 'int32', value: { kind: 'message', type: 'fi.shop.v1.Order.Line' } });
    expect(field(o, 'colorsByName').type).toEqual({ kind: 'map', key: 'string', value: { kind: 'enum', type: 'fi.shop.v1.Color' } });
    expect(field(o, 'flags').type).toEqual({ kind: 'map', key: 'int64', value: { kind: 'scalar', scalar: 'bool' } });
    expect(field(o, 'blobs').type).toEqual({ kind: 'map', key: 'bool', value: { kind: 'scalar', scalar: 'bytes' } });
    expect(field(o, 'levels').type).toEqual({ kind: 'map', key: 'uint64', value: { kind: 'enum', type: 'fi.common.Level' } });
    expect(['cardToken', 'cash', 'invoice'].map((n) => field(o, n).oneof)).toEqual(['payment', 'payment', 'payment']);
    expect(field(o, 'orderId').oneof).toBeUndefined();
    expect(field(o, 'class').number).toBe(31);
    expect(field(o, 'customJson').number).toBe(32);
    expect(field(o, 'parent').type).toEqual({ kind: 'message', type: 'fi.shop.v1.Order' });
    expect(field(o, 'level').type).toEqual({ kind: 'enum', type: 'fi.common.Level' });
    for (const [n, t] of [
      ['createdAt', 'Timestamp'],
      ['ttl', 'Duration'],
      ['note', 'StringValue'],
      ['big', 'Int64Value'],
      ['meta', 'Struct'],
      ['anyValue', 'Value'],
      ['mask', 'FieldMask'],
      ['extra', 'Any'],
      ['gift', 'BoolValue'],
      ['listValue', 'ListValue'],
      ['rawValue', 'BytesValue'],
    ]) {
      expect(field(o, n).type).toEqual({ kind: 'message', type: `google.protobuf.${t}` });
      expect(s.message(`google.protobuf.${t}`)).toBeDefined();
    }
    expect(field(s.message('google.protobuf.Value'), 'nullValue').type).toEqual({ kind: 'enum', type: 'google.protobuf.NullValue' });
    expect(s.message('google.protobuf.Timestamp')!.fields.map((f) => f.name)).toEqual(['seconds', 'nanos']);
  });

  it('reads proto2 required fields and enums with their names', () => {
    const l = s.message('fi.legacy.Legacy')!;
    expect(field(l, 'id').required).toBe(true);
    expect(field(l, 'sub').required).toBe(true);
    expect(field(l, 'count').required).toBeUndefined();
    expect(field(l, 'nums').packed).toBe(true);
    expect(field(l, 'loose').packed).toBeUndefined();
    expect(field(l, 'kinds').type).toEqual({ kind: 'enum', type: 'fi.legacy.Legacy.Kind' });
    expect(s.enumType('fi.legacy.Legacy.Kind')?.values).toEqual([
      { name: 'A', number: 1 },
      { name: 'B', number: 2 },
    ]);
    expect(s.enumType('fi.shop.v1.Order.Line.Kind')?.values.map((x) => x.name)).toEqual(['KIND_UNSPECIFIED', 'PHYSICAL', 'DIGITAL']);
    expect(s.enumType('fi.common.Level')?.dartClass).toBe('Level');
  });

  it('accepts method paths as URLs', () => {
    expect(s.method('http://10.0.2.2:50051/fi.shop.v1.ShopService/GetOrder')?.responseType).toBe('fi.shop.v1.Order');
    expect(s.method('fi.shop.v1.ShopService/GetOrder')?.responseType).toBe('fi.shop.v1.Order');
    expect(s.method('/fi.shop.v1.ShopService/Nope')).toBeUndefined();
  });
});

describe('across protoc_plugin versions', () => {
  it('21.x–25.x give the same schema', () => {
    const base = shape(load('v25'));
    for (const v of VERSIONS) expect(shape(load(v)), v).toEqual(base);
  });

  it('protoc_plugin 25 without package:protobuf files falls back to the built-in well-known types', () => {
    const files = readGenerated(path.join(FIX, 'v25')).filter((f) => !f.path.includes('protobuf-6.1.0'));
    const s = loadGrpcSchema(files);
    expect(s.problems).toEqual([]);
    expect(shape(s)).toEqual(shape(load('v25')));
    expect(s.message('google.protobuf.Timestamp')?.file).toContain('built in');
  });
});

describe('robustness', () => {
  it('never throws on junk and reports problems in plain words', () => {
    const junk = [
      { path: 'a.pb.dart', text: 'class X extends $pb.GeneratedMessage { static final $pb.BuilderInfo _i = $pb.BuilderInfo(' },
      { path: 'b.pb.dart', text: '\u0000\u0001 {{{{ ((( """ \'\'\' class class class' },
      { path: 'c.pbgrpc.dart', text: 'class FooClient extends $grpc.Client { static final _$x = $grpc.ClientMethod<' },
      { path: 'd.pbenum.dart', text: 'class E extends $pb.ProtobufEnum { static const E A = E._(' },
      { path: 'e.pb.dart', text: '' },
      null,
      { path: 42, text: 'x' },
      { path: 'f.pb.dart' },
    ] as never[];
    const s = loadGrpcSchema(junk);
    expect(s.methods).toEqual([]);
    expect(Array.isArray(s.problems)).toBe(true);
    expect(loadGrpcSchema(undefined as never).messages).toEqual([]);
  });

  it('reports a message from a file that was not loaded, once, and keeps the rest', () => {
    const files = readGenerated(path.join(FIX, 'v25')).filter((f) => !f.path.endsWith('common.pb.dart') && !f.path.endsWith('common.pbenum.dart'));
    const s = loadGrpcSchema(files);
    expect(s.problems.length).toBeGreaterThan(0);
    expect(s.problems.every((p) => /isn't among the loaded generated files/.test(p))).toBe(true);
    expect(s.problems.some((p) => p.includes('Money'))).toBe(true);
    expect(s.method('/fi.shop.v1.ShopService/Nested')?.responseType).toBe('Money');
    expect(s.message('fi.shop.v1.Order')).toBeDefined();
  });

  it('caps problems at 50', () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `big${i}.pb.dart`, text: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    const s = loadGrpcSchema(files);
    expect(s.problems).toHaveLength(50);
    expect(s.problems[0]).toMatch(/larger than 2 MB/);
  });

  it('resolves package: imports by path suffix (pub cache layout, Windows separators)', () => {
    const files = readGenerated(path.join(FIX, 'v25')).map((f) => ({
      path: f.path.includes('protobuf-6.1.0') ? f.path : f.path.replace(path.join(FIX, 'v25'), path.join(FIX, 'app', 'lib', 'gen')),
      text: f.text,
    }));
    const win = files.map((f) => ({ path: f.path.replace(/\//g, '\\'), text: f.text }));
    for (const fs of [files, win]) {
      const s = loadGrpcSchema(fs);
      expect(s.problems).toEqual([]);
      expect(s.message('google.protobuf.Timestamp')?.file).toMatch(/timestamp\.pb\.dart$/);
    }
  });

  it('reads a hand-written minimal chain (older generators: `..a<Foo>(…, PbFieldType.OM, subBuilder: …)`, omitted names)', () => {
    const text = `
import 'package:protobuf/protobuf.dart' as $pb;
class Foo extends $pb.GeneratedMessage {
  static final $pb.BuilderInfo _i = $pb.BuilderInfo(const $core.bool.fromEnvironment('protobuf.omit_message_names') ? '' : 'Foo', package: const $pb.PackageName(const $core.bool.fromEnvironment('protobuf.omit_message_names') ? '' : 'x.y'), createEmptyInstance: create)
    ..a<Foo>(1, const $core.bool.fromEnvironment('protobuf.omit_field_names') ? '' : 'child', $pb.PbFieldType.OM, defaultOrMaker: Foo.getDefault, subBuilder: Foo.create)
    ..pc<Foo>(2, 'kids', $pb.PbFieldType.PM, subBuilder: Foo.create)
    ..e<Kind>(3, 'kind', $pb.PbFieldType.OE, defaultOrMaker: Kind.A, valueOf: Kind.valueOf, enumValues: Kind.values)
    ..a<$core.int>(4, 'neg', $pb.PbFieldType.OS3, defaultOrMaker: -1)
    ..hasRequiredFields = false
  ;
}
class Kind extends $pb.ProtobufEnum {
  static const Kind A = Kind._(0, const $core.bool.fromEnvironment('protobuf.omit_enum_names') ? '' : 'A');
  static const Kind B = Kind._(-1, 'B');
  const Kind._($core.int v, $core.String n) : super(v, n);
}`;
    const s = loadGrpcSchema([{ path: 'lib/foo.pb.dart', text }]);
    expect(s.problems).toEqual([]);
    const foo = s.message('x.y.Foo')!;
    expect(foo.fields.map((f) => [f.name, f.type, f.repeated ?? false])).toEqual([
      ['child', { kind: 'message', type: 'x.y.Foo' }, false],
      ['kids', { kind: 'message', type: 'x.y.Foo' }, true],
      ['kind', { kind: 'enum', type: 'x.y.Kind' }, false],
      ['neg', { kind: 'scalar', scalar: 'sint32' }, false],
    ]);
    expect(s.enumType('x.y.Kind')?.values).toEqual([
      { name: 'A', number: 0 },
      { name: 'B', number: -1 },
    ]);
  });

  it('takes streaming from the client class when the service base class is missing', () => {
    const file = readGenerated(path.join(FIX, 'v24')).find((f) => f.path.endsWith('shop.pbgrpc.dart'))!;
    const clientOnly = file.text.slice(0, file.text.indexOf('abstract class ShopServiceBase'));
    const others = readGenerated(path.join(FIX, 'v24')).filter((f) => f !== file);
    const s = loadGrpcSchema([...others, { path: file.path, text: clientOnly }]);
    expect(s.method('/fi.shop.v1.ShopService/Chat')).toMatchObject({ clientStreaming: true, serverStreaming: true });
    expect(s.method('/fi.shop.v1.ShopService/WatchOrders')).toMatchObject({ clientStreaming: false, serverStreaming: true });
    expect(s.method('/fi.shop.v1.ShopService/UploadLines')).toMatchObject({ clientStreaming: true, serverStreaming: false });
    expect(s.method('/fi.shop.v1.ShopService/GetOrder')).toMatchObject({ clientStreaming: false, serverStreaming: false });
  });

  it('takes methods from the service base class when the client class is missing', () => {
    const file = readGenerated(path.join(FIX, 'v23')).find((f) => f.path.endsWith('shop.pbgrpc.dart'))!;
    const start = file.text.indexOf('@$pb.GrpcServiceName');
    const end = file.text.indexOf('@$pb.GrpcServiceName', start + 1);
    const serverOnly = file.text.slice(0, start) + file.text.slice(end);
    const others = readGenerated(path.join(FIX, 'v23')).filter((f) => f !== file);
    const s = loadGrpcSchema([...others, { path: file.path, text: serverOnly }]);
    expect(s.methods.filter((m) => m.path.startsWith('/fi.shop'))).toHaveLength(6);
    expect(s.method('/fi.shop.v1.ShopService/UploadLines')).toMatchObject({ requestType: 'fi.shop.v1.Order.Line', clientStreaming: true, serverStreaming: false });
  });
});
