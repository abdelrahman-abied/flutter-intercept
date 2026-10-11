import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { decodeMessage, decodeRaw, encodeMessage, grpcCodec, loadGrpcSchema, skeleton } from '../../../src/grpc';
import { b64, FIX, readGenerated, vectors, VERSIONS } from './helpers';

const schemas = Object.fromEntries(VERSIONS.map((v) => [v, loadGrpcSchema(readGenerated(path.join(FIX, v)))]));
const s = schemas.v25;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ''), 'hex'));

/** What we expect for each vector: the canonical JSON (python protobuf), plus the unknown fields it drops. */
function expected(name: string, json: unknown): unknown {
  if (name.startsWith('unknown fields')) return { ...(json as object), '#2': '7', '#3': '3' };
  return json;
}

/** Paths where two JSON values differ. */
function diff(a: unknown, b: unknown, p = '$', out: string[] = []): string[] {
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}.${k}`, out);
  } else if (!Object.is(a, b) && !(typeof a === 'number' && typeof b === 'number' && a === b)) out.push(p);
  return out;
}

describe('decodeMessage against bytes from the Dart runtime', () => {
  for (const v of VERSIONS) {
    describe(`schema from protoc_plugin ${v}`, () => {
      for (const x of vectors) {
        it(x.name, () => {
          const r = decodeMessage(schemas[v], x.type, b64(x.base64));
          expect(r.error).toBeUndefined();
          expect(r.json).toEqual(expected(x.name, x.json));
        });
      }
    });
  }

  it("differs from Dart's toProto3Json() only where Dart strays from proto3 JSON", () => {
    // Dart (protobuf 6.1.0): fixed64 printed signed, sint64 extremes mis-decoded, floats widened to double,
    // Duration fractions not padded to 3/6/9 digits, an empty proto2 bytes field dropped.
    const known: Record<string, string[]> = {
      'scalars: typical': ['$.f', '$.s64'],
      'scalars: extremes': ['$.s64', '$.fx64'],
      'order: everything': ['$.ttl'],
      'legacy proto2 (defaults present on the wire)': ['$.data'],
    };
    for (const x of vectors) {
      if (x.dartJson === undefined) continue;
      const ours = decodeMessage(s, x.type, b64(x.base64)).json;
      expect(diff(ours, x.dartJson), x.name).toEqual(known[x.name] ?? []);
    }
    const t = vectors.find((x) => x.name === 'scalars: typical')!;
    expect((t.dartJson as Record<string, unknown>).fx64).toBe('1234567890123');
    expect((vectors.find((x) => x.name === 'scalars: extremes')!.dartJson as Record<string, unknown>).fx64).toBe('-1');
  });

  it('keeps -0.0 and NaN / Infinity as proto3 JSON does', () => {
    const legacy = vectors.find((x) => x.name.startsWith('legacy'))!;
    const json = decodeMessage(s, legacy.type, b64(legacy.base64)).json as Record<string, unknown>;
    expect(Object.is(json.flt, -0)).toBe(true);
    const nan = vectors.find((x) => x.name === 'scalars: nan')!;
    expect(decodeMessage(s, nan.type, b64(nan.base64)).json).toEqual({ d: 'NaN', f: 0.5 });
  });
});

describe('encodeMessage', () => {
  for (const x of vectors) {
    it(`round-trips ${x.name}`, () => {
      const want = expected(x.name, x.json);
      const enc = encodeMessage(s, x.type, want);
      expect(decodeMessage(s, x.type, enc).json).toEqual(want);
    });
  }

  it('writes the same bytes as the Dart runtime for canonical messages', () => {
    const same = vectors.filter((x) => !x.name.startsWith('unknown') && !x.name.startsWith('order: everything'));
    for (const x of same) expect(hex(encodeMessage(s, x.type, x.json)), x.name).toBe(hex(b64(x.base64)));
    // Map entries follow JSON key order, so the big Order matches once its maps are in Dart's insertion order.
    const order = vectors.find((x) => x.name === 'order: everything')!;
    const json = structuredClone(order.json) as Record<string, Record<string, unknown>>;
    json.linesByNo = { 1: json.linesByNo['1'], '-2': json.linesByNo['-2'] };
    json.meta = { n: json.meta.n, s: json.meta.s, b: json.meta.b, z: json.meta.z, l: json.meta.l, o: json.meta.o };
    const ours = encodeMessage(s, order.type, json);
    expect(ours.length).toBe(b64(order.base64).length);
    expect(decodeMessage(s, order.type, ours).json).toEqual(order.json);
  });

  it('accepts proto3 JSON variants: strings for numbers, enum numbers, URL-safe base64, snake_case keys, nulls', () => {
    const a = encodeMessage(s, 'fi.shop.v1.Scalars', {
      i32: '-5',
      i64: -7,
      u64: '18446744073709551615',
      d: 'Infinity',
      f: '1.5',
      color: 2,
      by: '-_8',
      opt_i32: 3,
      s: null,
    });
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', a).json).toEqual({
      i32: -5,
      i64: '-7',
      u64: '18446744073709551615',
      d: 'Infinity',
      f: 1.5,
      color: 'GREEN',
      by: '+/8=',
      optI32: 3,
    });
  });

  it('encodes well-known types from their JSON forms', () => {
    const json = {
      createdAt: '2024-02-29T23:59:59.5+01:00',
      ttl: '-0.25s',
      note: 'n',
      big: '42',
      meta: { a: [1, { b: null }], c: 'd' },
      anyValue: [true],
      mask: 'a.bC,d',
      extra: { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '3s' },
      gift: false,
      listValue: [],
      rawValue: 'AAE=',
    };
    const back = decodeMessage(s, 'fi.shop.v1.Order', encodeMessage(s, 'fi.shop.v1.Order', json)).json;
    expect(back).toEqual({ ...json, createdAt: '2024-02-29T22:59:59.500Z', ttl: '-0.250s' });
  });

  it('names the JSON path in errors', () => {
    const e = (type: string, json: unknown) => {
      try {
        encodeMessage(s, type, json);
      } catch (err) {
        return (err as Error).message;
      }
      return 'no error';
    };
    expect(e('fi.shop.v1.Order', { lines: [{}, { qty: 'many' }] })).toBe('$.lines[1].qty: expected an integer (int32)');
    expect(e('fi.shop.v1.Order', { lines: [{ price: { units: 1.5 } }] })).toBe('$.lines[0].price.units: expected an integer (int64), got 1.5');
    expect(e('fi.shop.v1.Order', { nope: 1 })).toBe('$.nope: fi.shop.v1.Order has no field "nope"');
    expect(e('fi.shop.v1.Order', { cardToken: 'x', invoice: true })).toBe('$.invoice: only one of oneof payment can be set (cardToken is set too)');
    expect(e('fi.shop.v1.Order', { level: 'LEVEL_MAX' })).toBe('$.level: "LEVEL_MAX" is not a value of fi.common.Level (LEVEL_UNSPECIFIED, LEVEL_LOW, LEVEL_HIGH)');
    expect(e('fi.shop.v1.Order', { labels: { 'a b': 5 } })).toBe('$.labels["a b"]: expected a string');
    expect(e('fi.shop.v1.Order', { blobs: { yes: '' } })).toBe('$.blobs.yes: a bool map key must be "true" or "false"');
    expect(e('fi.shop.v1.Order', { linesByNo: { x: {} } })).toBe('$.linesByNo.x: expected an integer (int32)');
    expect(e('fi.shop.v1.Order', { createdAt: 'yesterday' })).toBe('$.createdAt: expected an RFC 3339 timestamp like "2025-01-01T00:00:00Z"');
    expect(e('fi.shop.v1.Order', { lines: {} })).toBe('$.lines: expected a list');
    expect(e('fi.shop.v1.Scalars', { by: '%%%' })).toBe('$.by: expected base64 bytes');
    expect(e('fi.shop.v1.Scalars', { i32: 2147483648 })).toBe('$.i32: 2147483648 is out of range for int32');
    expect(e('fi.shop.v1.Scalars', { u64: '-1' })).toBe('$.u64: -1 is out of range for uint64');
    expect(e('fi.shop.v1.Scalars', { b: 'yes' })).toBe('$.b: expected true or false');
    expect(e('fi.shop.v1.Scalars', [])).toBe('$: expected an object for fi.shop.v1.Scalars');
    expect(e('fi.shop.v1.Order', { extra: { '@type': 'type.googleapis.com/x.Nope' } })).toBe("$.extra.@type: type.googleapis.com/x.Nope isn't in the loaded generated code");
    expect(e('nope.Type', {})).toBe('$: unknown message type nope.Type');
  });

  it('writes "#n" fields back as raw fields', () => {
    const json = { orderId: 'USD', '#2': '7', '#3': '3', '#9': { '#1': 'x' } };
    expect(decodeMessage(s, 'fi.shop.v1.GetOrderRequest', encodeMessage(s, 'fi.shop.v1.GetOrderRequest', json)).json).toEqual(json);
  });

  it('refuses output larger than 4 MB', () => {
    expect(() => encodeMessage(s, 'fi.shop.v1.Scalars', { s: 'x'.repeat(4 * 1024 * 1024 + 1) })).toThrow(/larger than/);
  });

  it('is exposed as the GrpcCodec object', () => {
    expect(grpcCodec.encodeMessage).toBe(encodeMessage);
    expect(Object.keys(grpcCodec).sort()).toEqual(['decodeMessage', 'decodeRaw', 'encodeMessage', 'loadGrpcSchema', 'skeleton']);
  });
});

describe('decodeMessage wire semantics', () => {
  it('accepts packed and unpacked encodings of the same repeated field and merges split messages', () => {
    // i32 (3) packed [1, 2] then unpacked 3; u32 (5, declared packed) sent unpacked.
    expect(decodeMessage(s, 'fi.shop.v1.Repeats', bytes('1a 02 01 02 18 03 28 07')).json).toEqual({ i32: [1, 2, 3], u32: [7] });
    // unpacked (18, declared unpacked) sent packed
    expect(decodeMessage(s, 'fi.shop.v1.Repeats', bytes('92 01 02 05 06')).json).toEqual({ unpacked: [5, 6] });
    // Order.cash (11) in two pieces: currency then units
    expect(decodeMessage(s, 'fi.shop.v1.Order', bytes('5a 05 0a 03 55 53 44 5a 02 10 07')).json).toEqual({ cash: { currency: 'USD', units: '7' } });
  });

  it('keeps the last value of a scalar and the last member of a oneof', () => {
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('18 01 18 02')).json).toEqual({ i32: 2 });
    // cardToken (10) then invoice (12) → invoice
    expect(decodeMessage(s, 'fi.shop.v1.Order', bytes('52 01 61 60 01')).json).toEqual({ invoice: true });
    // invoice then cash → cash
    expect(decodeMessage(s, 'fi.shop.v1.Order', bytes('60 01 5a 00')).json).toEqual({ cash: {} });
  });

  it('shows unknown numbers and mismatched wire types under "#n", repeated as lists', () => {
    // field 1 (orderId, a string) sent as a varint; field 7 twice
    expect(decodeMessage(s, 'fi.shop.v1.GetOrderRequest', bytes('08 05 38 01 38 02 42 02 08 01')).json).toEqual({
      '#1': '5',
      '#7': ['1', '2'],
      '#8': { '#1': '1' },
    });
  });

  it('shows unknown enum numbers as numbers and map entries with missing keys / values as defaults', () => {
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('90 01 63')).json).toEqual({ color: 99 });
    // labels (3): entry with only a value; linesByNo (4): entry with only a key
    expect(decodeMessage(s, 'fi.shop.v1.Order', bytes('1a 03 12 01 76 22 02 08 05')).json).toEqual({ labels: { '': 'v' }, linesByNo: { 5: {} } });
  });

  it('decodes fields of a type that was not loaded as raw', () => {
    const files = readGenerated(path.join(FIX, 'v25')).filter((f) => !/common\.pb(enum)?\.dart$/.test(f.path));
    const partial = loadGrpcSchema(files);
    const r = decodeMessage(partial, 'fi.shop.v1.Order', bytes('5a 07 0a 03 55 53 44 10 07 f0 01 02'));
    expect(r.json).toEqual({ cash: { '#1': 'USD', '#2': '7' }, level: 2 });
  });

  it('reports malformed input in plain words', () => {
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('18')).error).toMatch(/truncated varint/);
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('72 05 61')).error).toMatch(/runs past the end/);
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('0f')).error).toMatch(/invalid wire type 7/);
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('00')).error).toMatch(/invalid field number 0/);
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('0b 0c')).error).toMatch(/groups/);
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', bytes('18 ff ff ff ff ff ff ff ff ff ff 01')).error).toMatch(/longer than 10 bytes/);
    expect(decodeMessage(s, 'nope.Nope', new Uint8Array()).error).toBe('unknown message type nope.Nope');
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', 'x' as never).error).toBe('expected bytes');
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', new Uint8Array()).json).toEqual({});
  });

  it('is bounded: size, field count and depth', () => {
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', new Uint8Array(4 * 1024 * 1024 + 1)).error).toMatch(/larger than/);
    const many = new Uint8Array(200_002);
    for (let i = 0; i < many.length; i += 2) {
      many[i] = 0x18;
      many[i + 1] = 1;
    }
    expect(decodeMessage(s, 'fi.shop.v1.Scalars', many).error).toMatch(/more than 100000 fields/);
    // Bare.children nested 40 deep
    let deep: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 40; i++) {
      const len = deep.length;
      const lenBytes = len < 128 ? [len] : [(len & 0x7f) | 0x80, len >> 7];
      deep = new Uint8Array([0x12, ...lenBytes, ...deep]);
    }
    expect(decodeMessage(s, 'Bare', deep).error).toMatch(/nested deeper than 32/);
    expect(decodeRaw(deep).fields).toBeDefined(); // raw decoding stops guessing instead
  });
});

describe('decodeRaw', () => {
  it('decodes like protoc --decode_raw, guessing strings and nested messages', () => {
    const money = vectors.find((x) => x.name === 'money')!;
    expect(decodeRaw(b64(money.base64)).fields).toEqual([
      { number: 1, wireType: 2, value: 'CHF', as: 'string' },
      { number: 2, wireType: 0, value: '18446744073709551615', as: 'varint' },
      { number: 3, wireType: 0, value: '18446744073709551615', as: 'varint' },
    ]);
    const line = vectors.find((x) => x.name === 'order line')!;
    const fields = decodeRaw(b64(line.base64)).fields!;
    expect(fields.map((f) => [f.number, f.as])).toEqual([
      [1, 'string'],
      [2, 'varint'],
      [3, 'message'],
      [4, 'varint'],
      [5, 'message'], // "\n\tgift wrap" parses as a message, so it is one
      [5, 'string'], // an empty Note: zero bytes read as an empty string
    ]);
    expect(fields[2].value).toEqual([
      { number: 1, wireType: 2, value: 'USD', as: 'string' },
      { number: 2, wireType: 0, value: '9', as: 'varint' },
      { number: 3, wireType: 0, value: '990000000', as: 'varint' },
    ]);
  });

  it('shows fixed-width values and non-text bytes', () => {
    expect(decodeRaw(bytes('0d 01 00 00 00 11 ff ff ff ff ff ff ff ff 1a 02 ff 00')).fields).toEqual([
      { number: 1, wireType: 5, value: '1', as: 'fixed32' },
      { number: 2, wireType: 1, value: '18446744073709551615', as: 'fixed64' },
      { number: 3, wireType: 2, value: '/wA=', as: 'bytes' },
    ]);
  });

  it('reports malformed input and limits', () => {
    expect(decodeRaw(bytes('0a 05 01')).error).toMatch(/runs past the end/);
    expect(decodeRaw(bytes('0b')).error).toMatch(/groups/);
    expect(decodeRaw(new Uint8Array(4 * 1024 * 1024 + 1)).error).toMatch(/larger than/);
    expect(decodeRaw(null as never).error).toBe('expected bytes');
    expect(decodeRaw(new Uint8Array()).fields).toEqual([]);
  });
});

describe('skeleton', () => {
  it('lists every field with typical values, one oneof member, nested one level, cycles cut', () => {
    const sk = skeleton(s, 'fi.shop.v1.Order') as Record<string, unknown>;
    expect(sk).toMatchObject({
      orderId: '',
      lines: [{ sku: '', qty: 0, price: {}, kind: 'PHYSICAL', notes: [{}] }],
      labels: { key: '' },
      linesByNo: { 0: { sku: '' } },
      colorsByName: { key: 'RED' },
      flags: { 0: false },
      blobs: { true: '' },
      levels: { 0: 'LEVEL_LOW' },
      cardToken: '',
      createdAt: '2025-01-01T00:00:00Z',
      ttl: '1s',
      note: '',
      big: '0',
      meta: {},
      anyValue: null,
      mask: '',
      extra: { '@type': 'type.googleapis.com/google.protobuf.Empty' },
      gift: false,
      parent: {},
      level: 'LEVEL_LOW',
      class: '',
      customJson: '',
      listValue: [],
      rawValue: '',
    });
    expect('cash' in sk || 'invoice' in sk).toBe(false);
    expect(skeleton(s, 'Bare')).toEqual({ a: '', children: [{}] });
    expect(skeleton(s, 'fi.shop.v1.Scalars')).toMatchObject({ i64: '0', u64: '0', d: 0, b: false, by: '', color: 'RED' });
    expect(skeleton(s, 'google.protobuf.Timestamp')).toBe('2025-01-01T00:00:00Z');
    expect(skeleton(s, 'nope.Nope')).toBeUndefined();
  });

  it('encodes for every message of every fixture version', () => {
    for (const v of VERSIONS) {
      for (const m of schemas[v].messages) {
        const sk = skeleton(schemas[v], m.name);
        const enc = encodeMessage(schemas[v], m.name, sk);
        expect(decodeMessage(schemas[v], m.name, enc).error, `${v} ${m.name}`).toBeUndefined();
      }
    }
  });
});
