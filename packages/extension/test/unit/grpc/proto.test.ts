// CONTRACTS §17.5: `.proto` files as a schema source.
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, isGrpcGeneratedFile, isProtoFile, loadGrpcSchema, skeleton } from '../../../src/grpc';
import { b64, FIX, readGenerated, readProtos, schemaShape, vectors, VERSIONS } from './helpers';

const PROTO_DIR = path.join(FIX, 'proto');
const DEMO = path.join(__dirname, '..', '..', '..', '..', '..', 'samples', 'demo_app');
const fromProto = () => loadGrpcSchema(readProtos(PROTO_DIR));
const one = (text: string, name = 'x.proto') => loadGrpcSchema([{ path: `/w/app/protos/${name}`, text, label: `protos/${name}` }]);

describe('isProtoFile', () => {
  it('selects .proto files only', () => {
    expect(isProtoFile('/a/b/shop.proto')).toBe(true);
    expect(isProtoFile('C:\\a\\SHOP.PROTO')).toBe(true);
    expect(isProtoFile('shop.pb.dart')).toBe(false);
    expect(isProtoFile('shop.proto.bak')).toBe(false);
    expect(isGrpcGeneratedFile('shop.proto')).toBe(false);
  });
});

describe('a schema from .proto files alone', () => {
  const s = fromProto();

  it('loads the fixtures without problems, marked as .proto', () => {
    expect(s.problems).toEqual([]);
    expect(s.message('fi.shop.v1.Order')?.source).toBe('proto');
    expect(s.message('fi.shop.v1.Order')?.file.endsWith('shop.proto')).toBe(true);
    expect(s.message('fi.shop.v1.Order')?.line).toBeGreaterThan(1);
    expect(s.method('/fi.shop.v1.ShopService/Chat')?.source).toBe('proto');
  });

  for (const v of VERSIONS) {
    it(`equals the schema from protoc_plugin ${v} output (fields, json names, maps, oneofs, enums, Dart classes, streaming)`, () => {
      expect(schemaShape(s)).toEqual(schemaShape(loadGrpcSchema(readGenerated(path.join(FIX, v)))));
    });
  }

  it("equals the demo app's generated code", () => {
    const protos = loadGrpcSchema(readProtos(path.join(DEMO, 'protos')));
    const dart = loadGrpcSchema(readGenerated(path.join(DEMO, 'lib')));
    expect(protos.problems).toEqual([]);
    expect(protos.methods.length).toBeGreaterThan(0);
    expect(schemaShape(protos)).toEqual(schemaShape(dart));
  });

  for (const x of vectors) {
    it(`decodes and encodes the vector "${x.name}"`, () => {
      const want = x.name.startsWith('unknown fields') ? { ...(x.json as object), '#2': '7', '#3': '3' } : x.json;
      const r = decodeMessage(s, x.type, b64(x.base64));
      expect(r.error).toBeUndefined();
      expect(r.json).toEqual(want);
      expect(decodeMessage(s, x.type, encodeMessage(s, x.type, want)).json).toEqual(want);
    });
  }

  it('makes skeletons that encode for every message', () => {
    for (const m of s.messages) expect(decodeMessage(s, m.name, encodeMessage(s, m.name, skeleton(s, m.name))).error, m.name).toBeUndefined();
  });
});

describe('mixed .proto and generated Dart', () => {
  const dart = readGenerated(path.join(FIX, 'v25'));

  it('the generated Dart wins for the same names, without a problem', () => {
    const s = loadGrpcSchema([...readProtos(PROTO_DIR), ...dart]);
    expect(s.problems).toEqual([]);
    expect(s.message('fi.shop.v1.Order')?.source).toBe('pb.dart');
    expect(s.message('fi.shop.v1.Order')?.file.endsWith('shop.pb.dart')).toBe(true);
    expect(s.method('/fi.shop.v1.ShopService/GetOrder')?.source).toBe('pb.dart');
    expect(schemaShape(s)).toEqual(schemaShape(loadGrpcSchema(dart)));
    // order of the inputs doesn't matter
    expect(loadGrpcSchema([...dart, ...readProtos(PROTO_DIR)]).message('fi.shop.v1.Order')?.source).toBe('pb.dart');
  });

  it('a .proto fills in what the generated Dart lacks', () => {
    const noCommon = dart.filter((f) => !/common\.pb(enum)?\.dart$/.test(f.path));
    const common = readProtos(PROTO_DIR).filter((f) => f.path.endsWith('common.proto'));
    const extra = { path: '/w/app/protos/extra.proto', text: 'syntax = "proto3"; package fi.extra; import "common.proto";\nmessage Wallet { repeated fi.common.Money coins = 1; }\nservice WalletService { rpc Get(Wallet) returns (Wallet); }' };
    const s = loadGrpcSchema([...noCommon, ...common, extra]);
    expect(s.problems).toEqual([]);
    expect(s.message('fi.common.Money')?.source).toBe('proto');
    expect(s.message('fi.shop.v1.Order')?.source).toBe('pb.dart');
    expect(s.message('fi.shop.v1.Order')?.fields.find((f) => f.name === 'cash')?.type).toEqual({ kind: 'message', type: 'fi.common.Money' });
    expect(s.method('/fi.shop.v1.ShopService/Nested')?.responseType).toBe('fi.common.Money');
    expect(s.message('fi.extra.Wallet')?.fields[0]).toEqual({ number: 1, name: 'coins', type: { kind: 'message', type: 'fi.common.Money' }, repeated: true });
    expect(s.method('/fi.extra.WalletService/Get')).toMatchObject({ requestType: 'fi.extra.Wallet', source: 'proto' });
    const order = vectors.find((x) => x.name === 'order: everything')!;
    expect(decodeMessage(s, order.type, b64(order.base64)).json).toEqual(order.json);
  });
});

describe('.proto syntax', () => {
  it('reads proto2 / proto3 / editions details', () => {
    const s = one(`
      // comment /* not nested */
      edition = "2023";
      package a.b;
      option java_package = "x.y";
      option (my.opt) = { k: 1 nested { v: "}" } };
      import public "other.proto";
      message Outer {
        option deprecated = true;
        reserved 2, 15, 9 to 11;
        reserved "foo", "bar";
        extensions 100 to max;
        message Inner { enum K { option allow_alias = true; A = 0; B = 1; ALSO_B = 1 [deprecated = true]; NEG = -1; } }
        Inner.K k = 0x3;
        .a.b.Outer.Inner inner = 4 [json_name = "theInner", (custom).opt = { a: [1, 2] }];
        repeated int32 loose = 5 [features.repeated_field_encoding = EXPANDED];
        repeated int32 tight = 6;
        int32 must = 7 [features.field_presence = LEGACY_REQUIRED];
        map<sfixed64, Inner.K> m = 8;
        string snake_case_name = 012;
        string _lead = 13;
        oneof choice_of_thing { option (x) = 1; string a = 14; Inner b = 16; }
      }
      service S { option (svc) = true; rpc Do(stream Outer) returns (Outer) { option idempotency_level = NO_SIDE_EFFECTS; } rpc Plain (.a.b.Outer) returns (stream .a.b.Outer); }
    `);
    expect(s.problems).toEqual([]);
    const o = s.message('a.b.Outer')!;
    expect(o.fields).toEqual([
      { number: 3, name: 'k', type: { kind: 'enum', type: 'a.b.Outer.Inner.K' } },
      { number: 4, name: 'theInner', type: { kind: 'message', type: 'a.b.Outer.Inner' } },
      { number: 5, name: 'loose', type: { kind: 'scalar', scalar: 'int32' }, repeated: true },
      { number: 6, name: 'tight', type: { kind: 'scalar', scalar: 'int32' }, repeated: true, packed: true },
      { number: 7, name: 'must', type: { kind: 'scalar', scalar: 'int32' }, required: true },
      { number: 8, name: 'm', type: { kind: 'map', key: 'sfixed64', value: { kind: 'enum', type: 'a.b.Outer.Inner.K' } } },
      { number: 10, name: 'snakeCaseName', type: { kind: 'scalar', scalar: 'string' } },
      { number: 13, name: 'Lead', type: { kind: 'scalar', scalar: 'string' } },
      { number: 14, name: 'a', type: { kind: 'scalar', scalar: 'string' }, oneof: 'choiceOfThing' },
      { number: 16, name: 'b', type: { kind: 'message', type: 'a.b.Outer.Inner' }, oneof: 'choiceOfThing' },
    ]);
    expect(s.enumType('a.b.Outer.Inner.K')?.values).toEqual([
      { name: 'A', number: 0 },
      { name: 'B', number: 1 },
      { name: 'NEG', number: -1 },
    ]);
    expect(s.enumType('a.b.Outer.Inner.K')?.dartClass).toBe('Outer_Inner_K');
    expect(s.method('/a.b.S/Do')).toMatchObject({ requestType: 'a.b.Outer', clientStreaming: true, serverStreaming: false });
    expect(s.method('/a.b.S/Plain')).toMatchObject({ requestType: 'a.b.Outer', clientStreaming: false, serverStreaming: true });
  });

  it('resolves names from the innermost scope outwards, and packs by syntax', () => {
    const s = one(`
      syntax = "proto2";
      package p;
      message T { optional int32 outer = 1; }
      message A {
        message T { optional int32 inner = 1; }
        optional T t = 1;
        optional .p.T top = 2;
        repeated int32 plain = 3;
        repeated int32 packed = 4 [packed = true];
        required string id = 5;
        optional group G = 6 { optional int32 x = 1; }
      }`);
    const a = s.message('p.A')!;
    expect(a.fields.map((f) => [f.name, f.type.kind === 'message' ? f.type.type : f.type.kind, f.packed ?? false, f.required ?? false])).toEqual([
      ['t', 'p.A.T', false, false],
      ['top', 'p.T', false, false],
      ['plain', 'scalar', false, false],
      ['packed', 'scalar', true, false],
      ['id', 'scalar', false, true],
    ]);
    expect(s.problems).toEqual(['protos/x.proto: groups are not supported; the field is skipped (line 12)']);
  });

  it('names Dart classes like protoc_plugin (escapes, nesting, enums first)', () => {
    const s = one(`
      syntax = "proto3";
      message Outer { message Inner {} enum E { E0 = 0; } }
      message Outer_Inner {}
      message Outer_E {}
      enum Map { M0 = 0; }
      message class {}
      message _private {}
    `);
    const cls = (n: string) => s.message(n)?.dartClass ?? s.enumType(n)?.dartClass;
    expect(cls('Map')).toBe('Map_');
    expect(cls('Outer')).toBe('Outer');
    expect(cls('Outer.E')).toBe('Outer_E');
    expect(cls('Outer.Inner')).toBe('Outer_Inner');
    expect(cls('Outer_Inner')).toBe('Outer_Inner_');
    expect(cls('Outer_E')).toBe('Outer_E_');
    expect(cls('class')).toBe('class_');
    expect(cls('_private')).toBe('private_');
  });
});

describe('bad .proto input', () => {
  const cases: [string, string, RegExp][] = [
    ['unterminated string', 'syntax = "proto3;\nmessage A {}', /a string is never closed \(line 1\)/],
    ['unterminated comment', 'message A {} /* never closed', /a \/\* comment is never closed/],
    ['unclosed block', 'syntax = "proto3"; message A { int32 x = 1;', /the block of A is never closed/],
    ['group', 'syntax = "proto2"; message A { optional group G = 1 { optional int32 x = 1; } }', /groups are not supported/],
    ['extend', 'syntax = "proto2"; message A { extensions 10 to 20; } extend A { optional int32 e = 10; }', /extensions \("extend"\) are not supported/],
    ['unknown type', 'syntax = "proto3"; message A { Nope n = 1; }', /A\.n uses Nope, which isn't among the loaded files/],
    ['junk', '}}} = ; message { ] [ rpc', /unexpected/],
    ['bad number', 'syntax = "proto3"; message A { int32 x = abc; int32 y = 0; int32 z = 2; }', /expected a number/],
    ['bad map key', 'syntax = "proto3"; message A { map<float, int32> m = 1; }', /"float" can't be a map key/],
  ];
  for (const [name, text, re] of cases) {
    it(`${name}: a problem with the label, no throw`, () => {
      const s = one(text);
      expect(s.problems.some((p) => re.test(p)), s.problems.join(' | ')).toBe(true);
      expect(s.problems.every((p) => p.startsWith('protos/x.proto: ') && !p.includes('/w/app'))).toBe(true);
    });
  }

  it('keeps what it could read around an error', () => {
    const s = one('syntax = "proto3"; message A { int32 x = abc; int32 y = 2; } message B { string s = 1; }');
    expect(s.message('A')?.fields.map((f) => f.name)).toEqual(['y']);
    expect(s.message('B')?.fields.map((f) => f.name)).toEqual(['s']);
  });

  it('skips files over 2 MB and never throws on odd values', () => {
    expect(one('x'.repeat(2 * 1024 * 1024 + 1)).problems).toEqual(['protos/x.proto: larger than 2 MB, skipped']);
    expect(() => loadGrpcSchema([{ path: 'a.proto', text: undefined as never }, { path: 'b.proto', text: '\u0000\uffff' }])).not.toThrow();
  });

  it('is linear: crafted 1 MB files load in under 300 ms', () => {
    const crafted = [
      'message M {'.repeat(100_000),
      `syntax = "proto3"; ${Array.from({ length: 20_000 }, (_, i) => `message M${i} { int32 a = 1; repeated M${i} r = 2; }`).join('\n')}`,
      `message A { ${'int32 x = 1 [(o) = {'.repeat(50_000)}`,
      `service S { ${'rpc M (A) returns (B) { option x = {'.repeat(30_000)}`,
      '/*'.padEnd(1_000_000, '*'),
      `message A { ${'reserved 1 to 2, '.repeat(60_000)} }`,
    ];
    for (const text of crafted) {
      expect(text.length).toBeGreaterThan(900_000);
      const t = Date.now();
      const s = one(text);
      expect(Date.now() - t, text.slice(0, 30)).toBeLessThan(300);
      expect(Array.isArray(s.problems)).toBe(true);
    }
  });
});

describe('REVIEW-11 regressions', () => {
  it('#1: a message named only with underscores terminates', () => {
    const t = Date.now();
    const s = one('syntax = "proto3"; message _ { int32 a = 1; } enum __ { A = 0; } message _B {}');
    expect(Date.now() - t).toBeLessThan(50);
    expect(s.message('_')?.dartClass).toBe('x_');
    expect(s.enumType('__')?.dartClass).toBe('x__');
    expect(s.message('_B')?.dartClass).toBe('B_');
  });

  it('#1: 32k duplicate names load in under 300 ms, duplicates reported once each (capped) and skipped', () => {
    const text = `syntax = "proto3"; ${'message X{}'.repeat(32_000)}`;
    const t = Date.now();
    const s = one(text);
    expect(Date.now() - t).toBeLessThan(300);
    expect(s.messages.filter((m) => m.name === 'X')).toHaveLength(1);
    expect(s.problems[0]).toMatch(/^protos\/x\.proto: X is defined twice; the second one is skipped/);
    // distinct names that collide in Dart stay linear too
    // top-level A_B<i> first, then A.B<i>: every nested class collides and takes a suffix
    const flat = Array.from({ length: 16_000 }, (_, i) => `message A_B${i} {}`).join('');
    const nested = Array.from({ length: 16_000 }, (_, i) => `message B${i} {}`).join('');
    const collide = `syntax = "proto3"; ${flat} message A { ${nested} }`;
    const t2 = Date.now();
    const c = one(collide);
    expect(Date.now() - t2).toBeLessThan(300);
    expect(c.message('A.B15999')?.dartClass).toBe('A_B15999_');
  });

  it('#3: a 2 MB file with a 64 KB name loads in under 300 ms with one short problem', () => {
    const name = 'N'.repeat(64 * 1024);
    let body = '';
    for (let i = 1; body.length < 2 * 1024 * 1024 - name.length - 100; i++) body += `Y a${i}=${i};`;
    const text = `message ${name} {${body}}`;
    const t = Date.now();
    const s = one(text);
    expect(Date.now() - t).toBeLessThan(300);
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0].length).toBeLessThanOrEqual(300);
    expect(s.problems[0]).toMatch(/longer than 512 characters/);
  });

  it('#3: deep scopes with long names and many unresolved fields stay within the budget', () => {
    const seg = 'S'.repeat(500);
    let text = 'syntax = "proto3"; package p;';
    for (let d = 0; d < 2; d++) text += `message ${seg}${d} {`;
    for (let i = 1; text.length < 1_900_000; i++) text += `U${i} f${i} = ${i};`;
    text += '}}';
    const t = Date.now();
    const s = loadGrpcSchema([{ path: 'deep.proto', text }]);
    expect(Date.now() - t).toBeLessThan(600);
    expect(s.problems.length).toBeLessThanOrEqual(50);
    expect(s.problems.every((p) => p.length <= 300)).toBe(true);
  });

  it('caps every problem text at 300 characters', () => {
    const long = 'L'.repeat(500);
    const s = one(`syntax = "proto3"; package ${'q'.repeat(400)}; message M { ${long} f = 1; }`);
    expect(s.problems.length).toBeGreaterThan(0);
    for (const p of s.problems) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p.startsWith('protos/x.proto: ')).toBe(true);
    }
  });
});
