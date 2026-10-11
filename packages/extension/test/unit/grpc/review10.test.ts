// REVIEW-10 #2 (linear-time parsing, per-file budget), #4 (no absolute paths in problems), INFO (`__proto__` keys).
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, loadGrpcSchema, skeleton } from '../../../src/grpc';
import { FIX, readGenerated } from './helpers';

const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ''), 'hex'));

describe('linear-time parsing (REVIEW-10 #2)', () => {
  it('loads the crafted 1 MB ClientMethod file in under 300 ms', () => {
    const parts = ['class XClient extends Client {'];
    for (let i = 0; i < 32_000; i++) parts.push(` ClientMethod<A, B>('/p.S/M${i}')`);
    parts.push('}');
    const text = parts.join('\n');
    expect(text.length).toBeGreaterThan(1_000_000);
    const t = Date.now();
    const s = loadGrpcSchema([{ path: '/w/app/lib/x.pbgrpc.dart', text, label: 'lib/x.pbgrpc.dart' }]);
    expect(Date.now() - t).toBeLessThan(300);
    expect(Array.isArray(s.problems)).toBe(true);
  });

  it('loads 8 000 messages and 8 000 enums from one file quickly', () => {
    const parts: string[] = [];
    for (let i = 0; i < 8_000; i++) {
      parts.push(`class M${i} extends $pb.GeneratedMessage { static final $pb.BuilderInfo _i = $pb.BuilderInfo('M${i}', package: const $pb.PackageName('p'))..aOS(1, 'a'); }`);
      parts.push(`class M${i}_E extends $pb.ProtobufEnum { static const M${i}_E A = M${i}_E._(0, 'A'); }`);
    }
    const t = Date.now();
    const s = loadGrpcSchema([{ path: '/w/lib/big.pb.dart', text: parts.join('\n') }]);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(s.messages).toHaveLength(8_000);
    expect(s.enumType('p.M7999.E')?.values).toEqual([{ name: 'A', number: 0 }]);
  });

  it('does not rescan class headers without a body', () => {
    const t = Date.now();
    loadGrpcSchema([{ path: 'h.pb.dart', text: 'class A '.repeat(200_000) }]);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('skips a file over the token budget as "too complex to read"', () => {
    const s = loadGrpcSchema([{ path: '/w/app/lib/gen/x.pb.dart', text: ';'.repeat(2_000_001), label: 'lib/gen/x.pb.dart' }]);
    expect(s.problems).toEqual(['lib/gen/x.pb.dart: too complex to read']);
  });
});

describe('problem texts (REVIEW-10 #4)', () => {
  const root = path.join(FIX, 'v25');
  const files = readGenerated(root).filter((f) => !/common\.pb(enum)?\.dart$/.test(f.path));
  const broken = { path: path.join(root, 'broken.pb.dart'), text: 'class Broken extends $pb.GeneratedMessage { }' };
  const huge = { path: path.join(root, 'huge.pb.dart'), text: 'x'.repeat(2 * 1024 * 1024 + 1) };
  const complex = { path: path.join(root, 'complex.pb.dart'), text: ';'.repeat(2_000_001) };
  const absImport = {
    path: path.join(root, 'abs.pb.dart'),
    text: `import '${root}/gone.pb.dart' as $9;\nclass Abs extends $pb.GeneratedMessage { static final $pb.BuilderInfo _i = $pb.BuilderInfo('Abs', package: const $pb.PackageName('p'))..aOM<$9.Gone>(1, 'g', subBuilder: $9.Gone.create); }`,
  };
  const all = [...files, broken, huge, complex, absImport];

  it('never carry the absolute directory (file names by default)', () => {
    const s = loadGrpcSchema(all);
    expect(s.problems.length).toBeGreaterThanOrEqual(5);
    for (const p of s.problems) {
      expect(p).not.toContain(root);
      expect(p).not.toContain(FIX);
    }
    expect(s.problems).toContain("broken.pb.dart: couldn't read class Broken (no BuilderInfo)");
    expect(s.problems).toContain('huge.pb.dart: larger than 2 MB, skipped');
    expect(s.problems).toContain('complex.pb.dart: too complex to read');
    expect(s.problems.some((p) => p.startsWith('shop.pb.dart: ') && p.includes("(from 'common.pb.dart')"))).toBe(true);
    expect(s.problems.some((p) => p.startsWith('abs.pb.dart: ') && p.includes("(from 'gone.pb.dart')"))).toBe(true);
  });

  it('use the host label when given', () => {
    const s = loadGrpcSchema(all.map((f) => ({ ...f, label: `lib/gen/${path.basename(f.path)}` })));
    expect(s.problems.length).toBeGreaterThanOrEqual(5);
    for (const p of s.problems) {
      expect(p).not.toContain(root);
      expect(p.startsWith('lib/gen/')).toBe(true);
    }
  });
});

describe('__proto__ keys (REVIEW-10 INFO)', () => {
  const text = `
class M extends $pb.GeneratedMessage {
  static final $pb.BuilderInfo _i = $pb.BuilderInfo('M', package: const $pb.PackageName('x'), createEmptyInstance: create)
    ..aOS(1, '__proto__')
    ..m<$core.String, $core.String>(2, 'labels', entryClassName: 'M.LabelsEntry', keyFieldType: $pb.PbFieldType.OS, valueFieldType: $pb.PbFieldType.OS, packageName: const $pb.PackageName('x'))
    ..hasRequiredFields = false;
}`;
  const s = loadGrpcSchema([{ path: 'm.pb.dart', text }]);
  // __proto__ = "a"; labels = {"__proto__": "v", "k": "w"}
  const wire = bytes('0a 01 61  12 0e 0a 09 5f5f70726f746f5f5f 12 01 76  12 06 0a 01 6b 12 01 77');

  it('keeps a field and a map key named __proto__ as own properties', () => {
    expect(s.problems).toEqual([]);
    const json = decodeMessage(s, 'x.M', wire).json as Record<string, unknown>;
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(json, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(json, '__proto__')?.value).toBe('a');
    const labels = json.labels as Record<string, unknown>;
    expect(Object.getPrototypeOf(labels)).toBe(Object.prototype);
    expect(Object.keys(labels)).toEqual(['__proto__', 'k']);
    const text = JSON.stringify(json);
    expect(text).toBe('{"__proto__":"a","labels":{"__proto__":"v","k":"w"}}');
    expect(({} as Record<string, unknown>).k).toBeUndefined();
  });

  it('round-trips through JSON text and encodeMessage', () => {
    const json = JSON.parse(JSON.stringify(decodeMessage(s, 'x.M', wire).json));
    expect(Buffer.from(encodeMessage(s, 'x.M', json)).toString('hex')).toBe(Buffer.from(wire).toString('hex'));
    const sk = skeleton(s, 'x.M') as Record<string, unknown>;
    expect(Object.keys(sk)).toEqual(['__proto__', 'labels']);
  });

  it('ignores lookups of inherited names in its tables', () => {
    const odd = `
class N extends $pb.GeneratedMessage {
  static final $pb.BuilderInfo _i = $pb.BuilderInfo('N', package: const $pb.PackageName('x'))
    ..a<$core.int>(1, 'a', $pb.PbFieldType.Oconstructor)
    ..__proto__(2, 'b')
    ..aOS(3, 'c');
}`;
    const n = loadGrpcSchema([{ path: 'n.pb.dart', text: odd }]);
    expect(n.message('x.N')?.fields.map((f) => f.name)).toEqual(['c']);
    expect(n.problems).toEqual(["n.pb.dart: N field 1 (a) has a type this version can't read"]);
  });
});
