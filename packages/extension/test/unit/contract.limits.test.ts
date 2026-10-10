/** REVIEW-4 #3 (what the index may read), #5 (linear, capped, yielding) and #6 (values in messages). */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { checkValue, ModelLookup, shortText } from '../../src/contract/check';
import { ContractFs, ContractIndex, isSafePartOf, nodeFs } from '../../src/contract/core';
import { parseGeneratedDart, XType } from '../../src/contract/generated';
import { parseJson } from '../../src/contract/json';
import { LinkedModel } from '../../src/contract/owner';

/** In-memory fs that records every read; `links` maps a path to its real path (symlinks). */
function recFs(files: Record<string, string>, links: Record<string, string> = {}) {
  const reads: string[] = [];
  const real = (p: string) => links[p] ?? p;
  const f: ContractFs = {
    stat: (p) => (real(p) in files ? { mtimeMs: 1, size: files[real(p)].length, isFile: true } : undefined),
    read: (p, max) => {
      reads.push(p);
      const t = files[real(p)];
      return t !== undefined && t.length <= max ? t : undefined;
    },
    realpath: (p) => (real(p) in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)) ? real(p) : p),
  };
  return { fs: f, reads };
}

const gen = (partOf: string) => `part of '${partOf}';\nU _$UFromJson(Map<String, dynamic> json) => U(a: json['a'] as String);\n`;

describe('#3: what the index reads', () => {
  it('follows only relative .dart part-of URIs', () => {
    for (const ok of ['user.dart', '../models/user.dart', 'a/b.dart']) expect(isSafePartOf(ok), ok).toBe(true);
    for (const bad of ['/dev/zero', '/etc/passwd.dart', '//evil.example/share/x.dart', '\\\\evil\\share\\x.dart', 'C:/x.dart', 'c:x.dart', 'package:app/x.dart', 'dart:core', 'file:///x.dart', 'x.txt', 'a\\b.dart']) {
      expect(isSafePartOf(bad), bad).toBe(false);
    }
  });

  it('never reads part-of targets outside the workspace, devices or absolute paths', async () => {
    const files: Record<string, string> = {
      '/w/lib/a.g.dart': gen('/dev/zero'),
      '/w/lib/b.g.dart': gen('../../outside/lib/user.dart'),
      '/w/lib/c.g.dart': gen('//evil.example/share/x.dart'),
      '/w/lib/d.g.dart': gen('d.dart'),
      '/w/lib/d.dart': 'class U {\n  final String a;\n}',
      '/outside/lib/user.dart': 'class U {\n  final String a;\n}',
      '/dev/zero': 'x',
    };
    const { fs: f, reads } = recFs(files);
    const idx = new ContractIndex(f, { roots: () => ['/w'] });
    await idx.setFiles(['/w/lib/a.g.dart', '/w/lib/b.g.dart', '/w/lib/c.g.dart', '/w/lib/d.g.dart']);
    expect(reads.filter((p) => !p.startsWith('/w/'))).toEqual([]);
    expect(reads).not.toContain('/dev/zero');
    const linked = idx.allModels().filter((m) => m.sourceFile);
    expect(linked.map((m) => m.sourceFile)).toEqual(['/w/lib/d.dart']);
  });

  it('skips generated files (and owners) whose real path leaves the workspace', async () => {
    const files = { '/outside/x.g.dart': gen('x.dart'), '/w/lib/ok.g.dart': gen('evil.dart'), '/outside/evil.dart': 'class U { final String a; }' };
    const { fs: f, reads } = recFs(files, { '/w/lib/x.g.dart': '/outside/x.g.dart', '/w/lib/evil.dart': '/outside/evil.dart' });
    const idx = new ContractIndex(f, { roots: () => ['/w'] });
    await idx.setFiles(['/w/lib/x.g.dart', '/w/lib/ok.g.dart']);
    expect(reads).toEqual(['/w/lib/ok.g.dart']);
    expect(idx.allModels().map((m) => [m.generatedFile, m.sourceFile])).toEqual([['/w/lib/ok.g.dart', undefined]]);
  });

  it('caps each file and the total bytes', async () => {
    const big = gen('o.dart') + '// '.padEnd(2000, 'x');
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`/w/${i}.g.dart`] = big;
    files['/w/huge.g.dart'] = big.repeat(3);
    const idx = new ContractIndex(recFs(files).fs, { roots: () => ['/w'], maxFileBytes: 5000, maxTotalBytes: 5 * big.length });
    await idx.setFiles(Object.keys(files));
    expect(idx.allModels()).toHaveLength(5);
    expect(idx.skipped).toBe(6);
  });

  it('importUri never walks above the workspace', async () => {
    const files = { '/pubspec.yaml': 'name: root_pkg', '/w/lib/api.g.dart': "part of 'api.dart';\nclass _A implements A {}", '/w/lib/api.dart': "@RestApi()\nabstract class A {\n  @GET('/x')\n  Future<U> x();\n}" };
    const idx = new ContractIndex(recFs(files).fs, { roots: () => ['/w'] });
    await idx.setFiles(['/w/lib/api.g.dart']);
    expect(idx.endpoints).toHaveLength(1);
    expect(idx.endpoints[0].importUri).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('nodeFs.read refuses FIFOs and devices without blocking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-contract-'));
    try {
      const fifo = path.join(dir, 'pipe.g.dart');
      execFileSync('mkfifo', [fifo]);
      const t0 = Date.now();
      expect(nodeFs.read(fifo, 1_000_000)).toBeUndefined();
      expect(nodeFs.read('/dev/zero', 1_000_000)).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(1000);
      const big = path.join(dir, 'big.g.dart');
      fs.writeFileSync(big, 'x'.repeat(2000));
      expect(nodeFs.read(big, 1000)).toBeUndefined();
      expect(nodeFs.read(big, 5000)).toHaveLength(2000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#5: linear linking, bounded blocking', () => {
  function crafted(): Record<string, string> {
    const redirectOwner = ') = U;\n'.repeat(20_000).padEnd(200_000, ' '); // 200 KB of redirects
    let bigGen = "part of 'big.dart';\n";
    for (let m = 0; m < 400; m++) {
      bigGen += `M${m} _$M${m}FromJson(Map<String, dynamic> json) => M${m}(\n`;
      for (let f = 0; f < 30; f++) bigGen += `  f${f}: json['f${f}'] as String,\n`;
      bigGen += ');\n';
    }
    let bigOwner = '';
    for (let m = 0; m < 400; m++) bigOwner += `class M${m} {\n  M${m}();\n}\n`;
    while (bigOwner.length < 990_000) bigOwner += 'var a = b + c * d;\n'; // no field declarations: every lookup misses
    return { '/w/o.g.dart': gen('o.dart'), '/w/o.dart': redirectOwner, '/w/big.g.dart': bigGen, '/w/big.dart': bigOwner };
  }

  it('indexes the crafted files in well under 1 s without blocking the loop for more than 50 ms', async () => {
    const files = crafted();
    const idx = new ContractIndex(recFs(files).fs, { roots: () => ['/w'] });
    let last = performance.now();
    let maxGap = 0;
    let running = true;
    const probe = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (running) setImmediate(probe);
    };
    setImmediate(probe);
    const t0 = performance.now();
    await idx.setFiles(['/w/o.g.dart', '/w/big.g.dart']);
    const total = performance.now() - t0;
    running = false;
    expect(idx.allModels()).toHaveLength(401);
    expect(idx.model('M399')?.sourceLine).toBeGreaterThan(0);
    expect(total).toBeLessThan(1000);
    expect(maxGap).toBeLessThan(50);
  });
});

describe('#6: values in messages', () => {
  const model = (fields: [string, string, LinkedModel['fields'][number]['type']][]): LinkedModel =>
    ({
      name: 'S',
      fn: '_$SFromJson',
      generatedFile: '/w/s.g.dart',
      generatedLine: 1,
      fields: fields.map(([key, dartName, type]) => ({ key, dartName, type, nullable: false, hasDefault: false })),
    }) as LinkedModel;
  const run = (m: LinkedModel, body: string) => {
    const r = parseJson(body);
    if (!r.ok) throw new Error(r.error);
    const lookup: ModelLookup = { get: (n) => (n === m.name ? m : n === 'Inner' ? inner : undefined) };
    return checkValue(r.value, m, false, lookup, { method: 'GET', urlPath: '/s' }).violations;
  };
  const inner = model([['code', 'code', { kind: 'string' }]]);
  inner.name = 'Inner';
  const roleEnum: XType = { kind: 'enum', name: 'Role', values: ['a', 'b'], jsonValues: ['a', 'b'] };

  it('no raw values under sensitive keys (numbers, bools, enum values), nested too', () => {
    const m = model([
      ['session', 'session', { kind: 'string' }],
      ['access_token', 'accessToken', roleEnum],
      ['isAuthorized', 'flag', { kind: 'string' }],
      ['credentials', 'creds', { kind: 'model', name: 'Inner' }],
      ['apiKeys', 'keys', { kind: 'map', of: { kind: 'string' } }],
    ]);
    const vs = run(m, '{"session": 98234123, "access_token": "s3cr3t-TOKEN-value", "isAuthorized": true, "credentials": {"code": 4242}, "apiKeys": {"x": 777}}');
    expect(vs).toHaveLength(5);
    const all = JSON.stringify(vs);
    for (const secret of ['98234123', 's3cr3t', 'true', '4242', '777']) expect(all, secret).not.toContain(secret);
    expect(vs[0]).toMatchObject({ actual: 'number' });
    expect(vs[0].message).toBe("session is a number in GET /s → type 'int' is not a subtype of type 'String' in type cast");
    expect(vs[1].message).toContain('`[redacted]` is not one of the supported values: a, b');
    expect(vs[1].actual).toBe('unknown enum value');
  });

  it('other values are short, quoted and escaped (enum error included)', () => {
    const m = model([['role', 'role', roleEnum], ['n', 'n', { kind: 'string' }]]);
    const long = `x${'y'.repeat(500)}\u202e\u0007`;
    const vs = run(m, JSON.stringify({ role: long, n: 1e300 }));
    expect(vs[0].message).not.toContain('y'.repeat(41));
    expect(vs[0].message).toMatch(/`xy{39}…` is not one of/);
    const bidi = run(m, JSON.stringify({ role: 'a\u202eb\u0000', n: 'ok' }))[0];
    expect(bidi.message).not.toMatch(/[\u202e\u0000]/);
    expect(bidi.message).toContain('\\u202e');
    expect(vs[1].message).toContain('a number (1e+300)');
    expect(shortText('\ud83d\ude00'.repeat(30))).toMatch(/…$/);
    expect(shortText('\ud83d\ude00'.repeat(30)).slice(0, -1)).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('odd keys in paths are escaped', () => {
    const m = model([['by', 'by', { kind: 'map', of: { kind: 'string' } }]]);
    const v = run(m, JSON.stringify({ by: { 'a\u202eb': 1 } }))[0];
    expect(v.path).toBe("$.by['a\\u202eb']");
    expect(v.message).not.toContain('\u202e');
  });
});

describe('generated parser stays linear on long inputs', () => {
  it('a 1 MB generated file parses in one short block', () => {
    let text = '';
    for (let m = 0; text.length < 1_000_000; m++) text += `M${m} _$M${m}FromJson(Map<String, dynamic> json) => M${m}(a: json['a'] as String, b: (json['b'] as num).toInt());\n`;
    const t0 = performance.now();
    const info = parseGeneratedDart(text, '/w/x.g.dart');
    expect(info.models.length).toBeGreaterThan(5000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
