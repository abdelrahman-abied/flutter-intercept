// CONTRACTS §16.3 / §16.4: discovery of the generated gRPC Dart (roots, package_config packages with services, the
// protobuf package's well-known types, symlinks, caps), the schema service (load, debounced reload, on/off), and the
// pure helpers (method paths, message decoding, grpcMock encoding).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverGrpcFiles, isGrpcSchemaPath, MAX_GRPC_FILE_BYTES, parsePackageDirs, type GrpcDirent, type GrpcFs } from '../../src/grpc/discovery';
import { createGrpcSchemaService, scrubAbsolutePaths, decodeGrpcMessages, grpcCodeName, grpcMethodFromGlob, grpcMethodPath, grpcMockEncoder, hexOf, normalizeMethodName, rawToJson } from '../../src/grpc/service';
import type { GrpcSourceFile } from '../../src/grpc/types';
import { fakeCodec, fakeGrpc, grpcCall, pb, pb64 } from './grpc.fakes';

/** An in-memory tree: files (text), folders implied by paths, symlinks (path → target). */
class MemFs implements GrpcFs {
  files = new Map<string, string>();
  links = new Map<string, string>();
  reads: string[] = [];
  sizes = new Map<string, number>();
  /** realpath answers for files swapped behind our back (e.g. replaced by a link between readdir and read). */
  realOverride = new Map<string, string>();
  add(p: string, text = '// generated') {
    this.files.set(path.resolve(p), text);
  }
  private dirs(): Set<string> {
    const out = new Set<string>();
    for (const f of [...this.files.keys(), ...this.links.keys()]) {
      let d = path.dirname(f);
      while (!out.has(d)) {
        out.add(d);
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
      }
    }
    return out;
  }
  async readdir(dir: string): Promise<GrpcDirent[]> {
    const d = path.resolve(dir);
    const dirs = this.dirs();
    if (!dirs.has(d)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const names = new Map<string, GrpcDirent>();
    for (const f of this.files.keys()) if (path.dirname(f) === d) names.set(path.basename(f), { name: path.basename(f), dir: false, file: true, symlink: false });
    for (const sub of dirs) if (path.dirname(sub) === d && sub !== d) names.set(path.basename(sub), { name: path.basename(sub), dir: true, file: false, symlink: false });
    for (const l of this.links.keys()) if (path.dirname(l) === d) names.set(path.basename(l), { name: path.basename(l), dir: false, file: false, symlink: true });
    return [...names.values()];
  }
  async lstat(p: string) {
    const r = path.resolve(p);
    if (this.links.has(r)) return { size: 0, file: false, dir: false, symlink: true };
    if (this.files.has(r)) return { size: this.sizes.get(r) ?? this.files.get(r)!.length, file: true, dir: false, symlink: false };
    if (this.dirs().has(r)) return { size: 0, file: false, dir: true, symlink: false };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }
  async realpath(p: string) {
    const r = path.resolve(p);
    if (this.realOverride.has(r)) return this.realOverride.get(r)!;
    // a symlinked parent folder: /ws/app/lib/linked → /elsewhere
    for (const [from, to] of this.links) if (r.startsWith(from + path.sep)) return path.join(to, r.slice(from.length + 1));
    return r;
  }
  failRead = new Map<string, string>();
  async readFile(p: string) {
    const r = path.resolve(p);
    this.reads.push(r);
    const code = this.failRead.get(r);
    if (code) throw Object.assign(new Error(`${code}: permission denied, open '${r}'`), { code });
    const t = this.files.get(r);
    if (t === undefined) throw new Error('ENOENT');
    return t;
  }
}

const rel = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe('discoverGrpcFiles (CONTRACTS §16.3)', () => {
  it('finds *.pbgrpc / *.pb / *.pbenum in the roots, skipping build/, .dart_tool/ and other generated kinds', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/gen/shop.pbgrpc.dart');
    f.add('/ws/app/lib/gen/shop.pb.dart');
    f.add('/ws/app/lib/gen/shop.pbenum.dart');
    f.add('/ws/app/lib/gen/shop.pbjson.dart');
    f.add('/ws/app/lib/main.dart');
    f.add('/ws/app/build/x/shop.pb.dart');
    f.add('/ws/app/.dart_tool/x/shop.pb.dart');
    const r = await discoverGrpcFiles(['/ws/app'], f);
    expect(rel(r.files)).toEqual(['/ws/app/lib/gen/shop.pb.dart', '/ws/app/lib/gen/shop.pbenum.dart', '/ws/app/lib/gen/shop.pbgrpc.dart'].map((p) => path.resolve(p)).sort());
    expect(r.problems).toEqual([]);
    expect(r.sources).toEqual([path.resolve('/ws/app')]);
  });

  it('adds package_config packages that ship services, not other packages', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/main.dart');
    f.add(
      '/ws/app/.dart_tool/package_config.json',
      JSON.stringify({
        configVersion: 2,
        packages: [
          { name: 'app', rootUri: '../', packageUri: 'lib/' },
          { name: 'api_protos', rootUri: 'file:///pub/api_protos-1.0.0', packageUri: 'lib/' },
          { name: 'http', rootUri: 'file:///pub/http-1.2.0', packageUri: 'lib/' },
          { name: 'protobuf', rootUri: 'file:///pub/protobuf-4.0.0', packageUri: 'lib/' },
          { name: 'remote', rootUri: 'file://server/share/x', packageUri: 'lib/' },
        ],
      }),
    );
    f.add('/pub/api_protos-1.0.0/lib/src/svc.pbgrpc.dart');
    f.add('/pub/api_protos-1.0.0/lib/src/svc.pb.dart');
    f.add('/pub/api_protos-1.0.0/test/fixture.pb.dart'); // outside packageUri
    f.add('/pub/http-1.2.0/lib/only_messages.pb.dart'); // no service: skipped
    f.add('/pub/protobuf-4.0.0/lib/well_known_types/google/protobuf/empty.pb.dart');
    f.add('/pub/protobuf-4.0.0/lib/src/protobuf/builder_info.dart');
    const r = await discoverGrpcFiles(['/ws/app'], f);
    expect(rel(r.files)).toEqual(
      ['/pub/api_protos-1.0.0/lib/src/svc.pb.dart', '/pub/api_protos-1.0.0/lib/src/svc.pbgrpc.dart'].map((p) => path.resolve(p)).sort(),
    );
    expect(r.sources).toContain(path.resolve('/pub/api_protos-1.0.0'));
  });

  it('never follows symlinks and refuses files that resolve outside their root', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/a.pbgrpc.dart');
    f.links.set(path.resolve('/ws/app/lib/link.pb.dart'), path.resolve('/etc/secret.pb.dart'));
    f.add('/ws/app/lib/linked/inner.pb.dart');
    f.links.set(path.resolve('/ws/app/lib/linked'), path.resolve('/elsewhere'));
    f.files.set(path.resolve('/elsewhere/inner.pb.dart'), 'x');
    f.add('/ws/app/lib/swapped.pb.dart');
    f.realOverride.set(path.resolve('/ws/app/lib/swapped.pb.dart'), path.resolve('/etc/swapped.pb.dart'));
    const r = await discoverGrpcFiles(['/ws/app'], f);
    expect(rel(r.files)).toEqual([path.resolve('/ws/app/lib/a.pbgrpc.dart')]);
    expect(r.problems.join(' ')).toMatch(/swapped\.pb\.dart: it resolves outside its folder/);
    expect(f.reads.some((x) => x.startsWith(path.resolve('/etc')) || x.startsWith(path.resolve('/elsewhere')))).toBe(false);
  });

  it('labels files root-relative / package:…, and reports read errors by code only (REVIEW-10 #4)', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/gen/a.pbgrpc.dart');
    f.add('/ws/app/lib/gen/locked.pb.dart');
    f.failRead.set(path.resolve('/ws/app/lib/gen/locked.pb.dart'), 'EACCES');
    f.add('/ws/app/.dart_tool/package_config.json', JSON.stringify({ packages: [{ name: 'api', rootUri: 'file:///pub/api-1', packageUri: 'lib/' }] }));
    f.add('/pub/api-1/lib/src/s.pbgrpc.dart');
    const r = await discoverGrpcFiles(['/ws/app'], f);
    expect(r.files.map((x) => x.label).sort()).toEqual(['lib/gen/a.pbgrpc.dart', 'package:api/src/s.pbgrpc.dart']);
    expect(r.problems).toEqual(['gRPC schema: could not read lib/gen/locked.pb.dart (EACCES)']);
    expect(JSON.stringify(r.problems)).not.toContain(path.resolve('/ws'));
  });

  it('skips files over 2 MB and reports it', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/big.pb.dart');
    f.sizes.set(path.resolve('/ws/app/lib/big.pb.dart'), MAX_GRPC_FILE_BYTES + 1);
    f.add('/ws/app/lib/ok.pb.dart');
    const r = await discoverGrpcFiles(['/ws/app'], f);
    expect(rel(r.files)).toEqual([path.resolve('/ws/app/lib/ok.pb.dart')]);
    expect(r.problems[0]).toMatch(/big\.pb\.dart: larger than 2 MB/);
  });

  it('works on a real folder (node fs) and ignores missing roots', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-grpc-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib', 'x.pbgrpc.dart'), '// x');
      const r = await discoverGrpcFiles([dir, path.join(dir, 'missing')]);
      expect(r.files.map((x) => path.basename(x.path))).toEqual(['x.pbgrpc.dart']);
      expect(r.files[0].text).toBe('// x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parsePackageDirs keeps local packages only and isGrpcSchemaPath spots relevant changes', () => {
    const dirs = parsePackageDirs(path.resolve('/ws/app/.dart_tool/package_config.json'), JSON.stringify({ packages: [{ name: 'a', rootUri: '../pkgs/a/', packageUri: 'lib/' }, { name: 'b', rootUri: 'file://h/x' }, { name: 'c', rootUri: '../c', packageUri: '../../escape/' }] }));
    expect(dirs.map((d) => d.name)).toEqual(['a']);
    expect(dirs[0].lib).toBe(path.resolve('/ws/app/pkgs/a/lib'));
    expect(parsePackageDirs('/x/.dart_tool/package_config.json', 'not json')).toEqual([]);
    expect(isGrpcSchemaPath('/a/b/x.pbgrpc.dart')).toBe(true);
    expect(isGrpcSchemaPath('/a/b/x.pbenum.dart')).toBe(true);
    expect(isGrpcSchemaPath('/a/b/x.pbjson.dart')).toBe(false);
    expect(isGrpcSchemaPath('/a/.dart_tool/package_config.json')).toBe(true);
    expect(isGrpcSchemaPath('/a/package_config.json')).toBe(false);
  });
});

describe('createGrpcSchemaService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads on ready(), exposes the schema and status, and fires onDidChange', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/a.pbgrpc.dart', 'grpc');
    const loaded: { files?: GrpcSourceFile[][] } = {};
    const svc = createGrpcSchemaService({ codec: fakeCodec(loaded), roots: () => ['/ws/app'], fs: f, watch: false });
    const changed = vi.fn();
    svc.onDidChange(changed);
    expect(svc.schema()).toBeUndefined();
    await svc.ready();
    expect(svc.schema()?.methods.length).toBe(2);
    expect(svc.status()).toEqual({ methods: 2, messages: 4, problems: [], files: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(loaded.files?.[0].map((x) => x.path)).toEqual([path.resolve('/ws/app/lib/a.pbgrpc.dart')]);
    svc.dispose();
  });

  it('reloads debounced on relevant file changes only', async () => {
    vi.useFakeTimers();
    const f = new MemFs();
    f.add('/ws/app/lib/a.pbgrpc.dart');
    const loaded: { files?: GrpcSourceFile[][] } = {};
    const svc = createGrpcSchemaService({ codec: fakeCodec(loaded), roots: () => ['/ws/app'], fs: f, watch: false, debounceMs: 100 });
    await svc.ready();
    svc.fileChanged('/ws/app/lib/main.dart');
    await vi.advanceTimersByTimeAsync(200);
    expect(loaded.files).toHaveLength(1);
    svc.fileChanged('/ws/app/lib/a.pb.dart');
    svc.fileChanged('/ws/app/lib/b.pb.dart');
    await vi.advanceTimersByTimeAsync(50);
    expect(loaded.files).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(loaded.files).toHaveLength(2);
    svc.dispose();
  });

  it('off: no scan, no schema; turning it on loads, turning it off drops', async () => {
    let on = false;
    const f = new MemFs();
    f.add('/ws/app/lib/a.pbgrpc.dart');
    const loaded: { files?: GrpcSourceFile[][] } = {};
    const svc = createGrpcSchemaService({ codec: fakeCodec(loaded), roots: () => ['/ws/app'], enabled: () => on, fs: f, watch: false });
    await svc.ready();
    expect(loaded.files).toBeUndefined();
    expect(svc.schema()).toBeUndefined();
    expect(svc.status()).toBeUndefined();
    on = true;
    svc.enabledChanged();
    await svc.load();
    expect(svc.schema()).toBeDefined();
    on = false;
    svc.enabledChanged();
    await svc.load();
    expect(svc.schema()).toBeUndefined();
    svc.dispose();
  });

  it('reports discovery and parse problems; a throwing codec does not break it; no files = no schema', async () => {
    const f = new MemFs();
    f.add('/ws/app/lib/a.pbgrpc.dart');
    const codec = fakeCodec();
    codec.loadGrpcSchema = () => {
      throw new Error('tokenizer exploded');
    };
    const svc = createGrpcSchemaService({ codec, roots: () => ['/ws/app'], fs: f, watch: false });
    await svc.ready();
    expect(svc.schema()).toBeUndefined();
    expect(svc.status()?.problems[0]).toMatch(/tokenizer exploded/);
    const empty = createGrpcSchemaService({ codec: fakeCodec(), roots: () => ['/nothing'], fs: new MemFs(), watch: false });
    await empty.ready();
    expect(empty.schema()).toBeUndefined();
    expect(empty.status()).toEqual({ methods: 0, messages: 0, problems: [], files: 0 });
  });

  it('uses the injected watcher and re-watches on rootsChanged', async () => {
    const watch = vi.fn(() => ({ dispose: vi.fn() }));
    const svc = createGrpcSchemaService({ codec: fakeCodec(), roots: () => ['/ws/app'], fs: new MemFs(), watch });
    await svc.ready();
    expect(watch).toHaveBeenCalledWith(['/ws/app'], expect.any(Function));
    svc.rootsChanged();
    expect(watch).toHaveBeenCalledTimes(2);
    svc.dispose();
  });
});

describe('gRPC helpers', () => {
  it('method paths from URLs, globs and names', () => {
    expect(grpcMethodPath('http://10.0.2.2:50051/shop.v1.CartService/AddItem')).toBe('/shop.v1.CartService/AddItem');
    expect(grpcMethodPath('https://h/a/b/c')).toBeUndefined();
    expect(grpcMethodFromGlob('*/shop.v1.CartService/AddItem')).toBe('/shop.v1.CartService/AddItem');
    expect(grpcMethodFromGlob('https://api.example.com/shop.v1.CartService/AddItem*')).toBe('/shop.v1.CartService/AddItem');
    expect(grpcMethodFromGlob('*/shop.v1.CartService/*')).toBeUndefined();
    expect(normalizeMethodName('shop.v1.CartService/AddItem')).toBe('/shop.v1.CartService/AddItem');
    expect(normalizeMethodName('shop.v1.CartService.AddItem')).toBe('/shop.v1.CartService/AddItem');
    expect(normalizeMethodName('nope')).toBeUndefined();
    expect(grpcCodeName(14)).toBe('UNAVAILABLE');
    expect(grpcCodeName(99)).toBe('CODE 99');
    expect(grpcCodeName(1.5)).toBeUndefined();
  });

  it('scrubAbsolutePaths replaces POSIX, Windows, UNC and file:// paths (also with spaces) and known folders', () => {
    const show = (p: string) => `<${path.basename(p.replace(/\\/g, '/'))}>`;
    expect(scrubAbsolutePaths('/Users/Ada Lovelace/app/lib/x.pb.dart: Order.total uses Money', show)).toBe('<x.pb.dart>: Order.total uses Money');
    expect(scrubAbsolutePaths("could not read 'C:\\Users\\ada\\app\\y.pbgrpc.dart' now", show)).toBe("could not read '<y.pbgrpc.dart>' now");
    expect(scrubAbsolutePaths('see file:///home/ada/z.pb.dart and \\\\srv\\share\\w', show)).toBe('see <z.pb.dart> and <w>');
    expect(scrubAbsolutePaths('package:api/src/s.pb.dart: fine, ratio 1/2', show)).toBe('package:api/src/s.pb.dart: fine, ratio 1/2');
    expect(scrubAbsolutePaths('in /home/ada', show, ['/home/ada'])).not.toContain('/home/ada');
    expect(scrubAbsolutePaths('x=/home/ada/secret', () => '…', ['/home/ada'])).toBe('x=…');
  });

  it('rawToJson groups repeated field numbers', () => {
    expect(
      rawToJson([
        { number: 1, wireType: 2, value: 'a' },
        { number: 1, wireType: 2, value: 'b' },
        { number: 1, wireType: 2, value: 'c' },
        { number: 2, wireType: 2, value: [{ number: 3, wireType: 0, value: '7' }] },
      ]),
    ).toEqual({ '1': ['a', 'b', 'c'], '2': { '3': '7' } });
    expect(hexOf(new Uint8Array([1, 2, 255]), 2)).toBe('0102');
  });

  it('decodeGrpcMessages: schema, raw fallback, nothing; never throws', () => {
    const g = fakeGrpc();
    const call = grpcCall();
    const d = decodeGrpcMessages(call, g);
    expect(d.path).toBe('/shop.v1.CartService/AddItem');
    expect(d.method?.responseType).toBe('shop.v1.Cart');
    expect(d.messages.map((m) => [m.dir, m.via])).toEqual([
      ['send', 'schema'],
      ['receive', 'schema'],
    ]);
    expect(d.messages[0].json).toEqual({ sku: 'A1', quantity: 2, sessionToken: 'tok-123' });
    // unknown method → raw
    const raw = decodeGrpcMessages({ ...call, url: 'http://h/other.Svc/Do' }, g);
    expect(raw.messages[0].via).toBe('raw');
    expect(raw.messages[0].json).toEqual({ '1': expect.stringContaining('PB:') });
    // no schema at all, truncated frames, garbage and missing bytes
    const none = decodeGrpcMessages(
      {
        url: call.url,
        frames: [
          { dir: 'receive', at: 1, kind: 'message', base64: Buffer.from('garbage').toString('base64'), size: 7 },
          { dir: 'receive', at: 2, kind: 'message', size: 9 },
          { dir: 'receive', at: 3, kind: 'message', base64: pb64({ total: '1' }), size: 99999, truncated: true },
          { dir: 'send', at: 4, kind: 'text', text: 'x', size: 1 },
        ],
      },
      fakeGrpc({ schema: null }),
    );
    expect(none.messages.map((m) => m.via)).toEqual(['none', 'none', 'raw']);
    expect(none.messages[1].error).toMatch(/not recorded/);
    expect(none.messages[2].truncated).toBe(true);
    const throwing = fakeGrpc();
    throwing.codec.decodeMessage = () => {
      throw new Error('boom');
    };
    expect(decodeGrpcMessages(call, throwing).messages[0]).toMatchObject({ via: 'raw', error: expect.stringMatching(/boom/) });
    expect(decodeGrpcMessages(call, undefined).messages[0]).toMatchObject({ via: 'none', error: expect.stringMatching(/not available/) });
  });

  it('grpcMockEncoder encodes response JSON for the rule URL, with readable errors', () => {
    const g = fakeGrpc();
    const enc = grpcMockEncoder(g);
    expect(enc('*/shop.v1.CartService/AddItem', [{ total: '5' }])).toEqual([Buffer.from(pb({ total: '5' })).toString('base64')]);
    expect(() => enc('*/shop.v1.CartService/*', [{}])).toThrow(/doesn't name one gRPC method/);
    expect(() => enc('*/x.Y/Z', [{}])).toThrow(/no method \/x\.Y\/Z/);
    expect(() => enc('*/shop.v1.CartService/AddItem', [{ nope: 1 }])).toThrow(/message 1 \(shop\.v1\.Cart\): \$\.nope/);
    expect(() => grpcMockEncoder(fakeGrpc({ schema: null }))('*/shop.v1.CartService/AddItem', [{}])).toThrow(/no protobuf schema/);
    const off = fakeGrpc();
    off.on = false;
    expect(() => grpcMockEncoder(off)('*/shop.v1.CartService/AddItem', [{}])).toThrow(/off/);
  });
});

// With agent S's real parser and codec (src/grpc/index.ts) over the e2e test server's protoc output.
const E2E_GEN = path.resolve(__dirname, '../../../../scripts/e2e/grpc_server');
describe.skipIf(!fs.existsSync(path.join(E2E_GEN, 'lib/src/generated/demo/orders/v1/orders.pbgrpc.dart')))('with the real codec', () => {
  it('discovers, loads and decodes the e2e server schema', async () => {
    const { grpcCodec } = await import('../../src/grpc/index');
    const svc = createGrpcSchemaService({ codec: grpcCodec, roots: () => [E2E_GEN], watch: false });
    await svc.ready();
    const schema = svc.schema();
    expect(schema?.methods.length).toBeGreaterThan(0);
    const m = schema!.methods[0];
    const sk = grpcCodec.skeleton(schema!, m.responseType);
    const b64 = grpcMockEncoder(svc)(`*${m.path}`, [sk])[0];
    const back = decodeGrpcMessages({ url: `http://h:1${m.path}`, frames: [{ dir: 'receive', at: 1, kind: 'message', base64: b64, size: 1 }] }, svc);
    expect(back.messages[0].via).toBe('schema');
    svc.dispose();
  });
});
