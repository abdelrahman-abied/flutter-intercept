import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StackFrame } from '@flutter-intercept/proxy';
import { checkSourcePath, clearPackageConfigCache, isUncPath, packageRootsFor, projectRelative, resolveFrames, SourceFs } from '../../src/source/resolve';

const ROOT = path.resolve('/work/app');
const PUB = path.resolve('/home/me/.pub-cache/hosted/pub.dev');

/** In-memory fs: path -> {text, mtimeMs}; counts reads so the mtime cache is observable. */
function fakeFs(files: Record<string, { text: string; mtimeMs?: number }>) {
  const reads: string[] = [];
  const fs: SourceFs & { reads: string[]; files: typeof files } = {
    reads,
    files,
    statSync(p) {
      const f = files[path.resolve(p)];
      if (!f) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return { mtimeMs: f.mtimeMs ?? 1 };
    },
    readFileSync(p) {
      const f = files[path.resolve(p)];
      if (!f) throw new Error(`ENOENT ${p}`);
      reads.push(path.resolve(p));
      return f.text;
    },
  };
  return fs;
}

const config = (packages: object[]) => JSON.stringify({ configVersion: 2, packages });
const appConfig = () =>
  config([
    { name: 'demo_app', rootUri: '../', packageUri: 'lib/', languageVersion: '3.9' },
    { name: 'dio', rootUri: pathToFileURL(path.join(PUB, 'dio-5.11.1')).href, packageUri: 'lib/', languageVersion: '2.18' },
    { name: 'local_pkg', rootUri: '../packages/local_pkg', packageUri: 'lib/' },
    { name: 'no_lib', rootUri: '../tool_pkg' },
  ]);

const frame = (uri: string, line?: number, column?: number, fn = 'f'): StackFrame => ({ fn, uri, line, column });

describe('resolveFrames', () => {
  beforeEach(() => clearPackageConfigCache());

  it('maps package: URIs through .dart_tool/package_config.json (rootUri relative to the config file)', () => {
    const fs = fakeFs({ [path.join(ROOT, '.dart_tool', 'package_config.json')]: { text: appConfig() } });
    const out = resolveFrames(
      [
        frame('package:demo_app/api/orders_api.dart', 15, 20, 'OrdersApi.createOrder'),
        frame('package:dio/src/dio_mixin.dart', 71, 12),
        frame('package:local_pkg/a.dart', 1, 1),
        frame('package:no_lib/x.dart', 2),
      ],
      [ROOT],
      fs,
    );
    expect(out[0]).toEqual({ fn: 'OrdersApi.createOrder', uri: 'package:demo_app/api/orders_api.dart', line: 15, column: 20, path: path.join(ROOT, 'lib', 'api', 'orders_api.dart'), inProject: true });
    expect(out[1].path).toBe(path.join(PUB, 'dio-5.11.1', 'lib', 'src', 'dio_mixin.dart'));
    expect(out[1].inProject).toBe(false);
    expect(out[2]).toMatchObject({ path: path.join(ROOT, 'packages', 'local_pkg', 'lib', 'a.dart'), inProject: true });
    // No packageUri: the package root itself.
    expect(out[3].path).toBe(path.join(ROOT, 'tool_pkg', 'x.dart'));
  });

  it('keeps file:// URIs, decodes them, and never gives dart:/unknown URIs a path', () => {
    const fs = fakeFs({});
    const entry = path.join(ROOT, '.dart_tool', 'flutter_intercept', 'entry_lib__main.dart');
    const out = resolveFrames(
      [
        frame(pathToFileURL(path.join(ROOT, 'bin', 'my tool.dart')).href, 3, 1),
        frame(pathToFileURL(entry).href, 160, 28, '_traced'),
        frame('dart:async/zone.dart', 1),
        frame('org-dartlang-sdk:///sdk/lib/async/zone.dart', 1),
        frame('package:unknown/x.dart', 1),
        frame('package:', 1),
      ],
      [ROOT],
      fs,
    );
    expect(out[0]).toMatchObject({ path: path.join(ROOT, 'bin', 'my tool.dart'), inProject: true });
    // The generated entry lives in the project but is never "project code".
    expect(out[1]).toMatchObject({ path: entry, inProject: false });
    for (const f of out.slice(2)) {
      expect(f.path).toBeUndefined();
      expect(f.inProject).toBe(false);
    }
  });

  it('decodes percent-encoded package paths and refuses paths escaping the package', () => {
    const fs = fakeFs({ [path.join(ROOT, '.dart_tool', 'package_config.json')]: { text: appConfig() } });
    const [spaced, escape] = resolveFrames([frame('package:demo_app/src/my%20file.dart', 1), frame('package:dio/../../../../etc/passwd', 1)], [ROOT], fs);
    expect(spaced.path).toBe(path.join(ROOT, 'lib', 'src', 'my file.dart'));
    expect(escape.path).toBeUndefined();
  });

  it('finds the package config of a pub workspace above the project root', () => {
    const ws = path.resolve('/work/mono');
    const pkg = path.join(ws, 'apps', 'shop');
    const fs = fakeFs({
      [path.join(ws, '.dart_tool', 'package_config.json')]: { text: config([{ name: 'shop', rootUri: '../apps/shop', packageUri: 'lib/' }]) },
    });
    const [f] = resolveFrames([frame('package:shop/main.dart', 9)], [pkg], fs);
    expect(f).toMatchObject({ path: path.join(pkg, 'lib', 'main.dart'), inProject: true });
  });

  it('caches each package config by mtime', () => {
    const cfg = path.join(ROOT, '.dart_tool', 'package_config.json');
    const fs = fakeFs({ [cfg]: { text: appConfig(), mtimeMs: 1 } });
    resolveFrames([frame('package:demo_app/a.dart', 1)], [ROOT], fs);
    resolveFrames([frame('package:demo_app/b.dart', 1), frame('package:dio/dio.dart', 1)], [ROOT], fs);
    expect(fs.reads).toHaveLength(1);
    // `flutter pub get` rewrote it: the new mapping is used.
    fs.files[cfg] = { text: config([{ name: 'demo_app', rootUri: '../', packageUri: 'src/' }]), mtimeMs: 2 };
    const [f] = resolveFrames([frame('package:demo_app/a.dart', 1)], [ROOT], fs);
    expect(fs.reads).toHaveLength(2);
    expect(f.path).toBe(path.join(ROOT, 'src', 'a.dart'));
  });

  it('survives a missing or broken config, and prefers the first root that knows the package', () => {
    const other = path.resolve('/work/other');
    const fs = fakeFs({
      [path.join(ROOT, '.dart_tool', 'package_config.json')]: { text: '{not json' },
      [path.join(other, '.dart_tool', 'package_config.json')]: { text: config([{ name: 'demo_app', rootUri: '../', packageUri: 'lib/' }]) },
    });
    expect(resolveFrames([frame('package:demo_app/a.dart', 1)], [path.resolve('/nowhere')], fakeFs({}))[0].path).toBeUndefined();
    const [f] = resolveFrames([frame('package:demo_app/a.dart', 1)], [ROOT, other], fs);
    expect(f.path).toBe(path.join(other, 'lib', 'a.dart'));
    expect(f.inProject).toBe(true);
  });

  it('keeps frame fields (afterAsyncGap, missing line/column) untouched', () => {
    const fs = fakeFs({ [path.join(ROOT, '.dart_tool', 'package_config.json')]: { text: appConfig() } });
    const [f] = resolveFrames([{ fn: 'x', uri: 'package:demo_app/a.dart', afterAsyncGap: true }], [ROOT], fs);
    expect(f).toEqual({ fn: 'x', uri: 'package:demo_app/a.dart', afterAsyncGap: true, path: path.join(ROOT, 'lib', 'a.dart'), inProject: true });
  });
});

describe('projectRelative', () => {
  it('is relative to the deepest containing root with / separators, undefined outside every root', () => {
    const mono = path.resolve('/work/mono');
    const app = path.join(mono, 'apps', 'shop');
    expect(projectRelative(path.join(app, 'lib', 'api', 'orders.dart'), [mono, app])).toBe('lib/api/orders.dart');
    expect(projectRelative(path.join(mono, 'packages', 'core', 'lib', 'x.dart'), [app, mono])).toBe('packages/core/lib/x.dart');
    expect(projectRelative(path.join(PUB, 'dio-5.11.1', 'lib', 'dio.dart'), [mono])).toBeUndefined();
    expect(projectRelative(path.resolve('/work/mono-other/x.dart'), [mono])).toBeUndefined();
    expect(projectRelative(app, [app])).toBe('');
  });
});

describe('REVIEW-3 #3: app-controlled frames never name remote or out-of-workspace files', () => {
  beforeEach(() => clearPackageConfigCache());

  it('gives no path to file://<host>/… (UNC) URIs, nor to a package root on a remote host', () => {
    const fs = fakeFs({
      [path.join(ROOT, '.dart_tool', 'package_config.json')]: {
        text: config([
          { name: 'remote', rootUri: 'file://evil.example/share/pkg/', packageUri: 'lib/' },
          { name: 'remote2', rootUri: 'file://localhost/etc/', packageUri: 'lib/' },
          { name: 'demo_app', rootUri: '../', packageUri: 'lib/' },
        ]),
      },
    });
    const out = resolveFrames(
      [frame('file://evil.example/share/x.dart', 1), frame('file://localhost/etc/passwd', 1), frame('file:////evil.example/share/x.dart', 1), frame('package:remote/a.dart', 1), frame('package:remote2/a.dart', 1)],
      [ROOT],
      fs,
    );
    for (const f of out) expect(f.path, f.uri).toBeUndefined();
    expect(packageRootsFor([ROOT], fs)).toEqual([ROOT]);
  });

  it('isUncPath', () => {
    expect(isUncPath('\\\\host\\share\\a.dart')).toBe(true);
    expect(isUncPath('//host/share/a.dart')).toBe(true);
    expect(isUncPath('\\\\?\\C:\\a.dart')).toBe(true);
    expect(isUncPath('/work/a.dart')).toBe(false);
    expect(isUncPath('C:\\work\\a.dart')).toBe(false);
  });

  it('packageRootsFor lists every package root of each config (pub cache, path deps, the app), deduplicated', () => {
    const fs = fakeFs({ [path.join(ROOT, '.dart_tool', 'package_config.json')]: { text: appConfig() } });
    expect(packageRootsFor([ROOT, ROOT, path.resolve('/nowhere')], fs).sort()).toEqual(
      [ROOT, path.join(PUB, 'dio-5.11.1'), path.join(ROOT, 'packages', 'local_pkg'), path.join(ROOT, 'tool_pkg')].sort(),
    );
  });

  describe('checkSourcePath (real files and symlinks)', () => {
    let tmp: string;
    let ws: string;
    let pub: string;
    let outside: string;
    beforeAll(() => {
      tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'fi-src-')));
      ws = path.join(tmp, 'ws');
      pub = path.join(tmp, 'pub', 'dio-5.11.1');
      outside = path.join(tmp, 'secret');
      for (const d of [path.join(ws, 'lib'), path.join(pub, 'lib'), outside]) nodeFs.mkdirSync(d, { recursive: true });
      nodeFs.writeFileSync(path.join(ws, 'lib', 'main.dart'), 'void main() {}\n');
      nodeFs.writeFileSync(path.join(pub, 'lib', 'dio.dart'), '//\n');
      nodeFs.writeFileSync(path.join(outside, 'id_rsa'), 'x');
      nodeFs.symlinkSync(path.join(outside, 'id_rsa'), path.join(ws, 'lib', 'link_out.dart'));
      nodeFs.symlinkSync(outside, path.join(ws, 'lib', 'dir_out'));
      nodeFs.symlinkSync(path.join(ws, 'lib', 'main.dart'), path.join(tmp, 'link_in.dart'));
    });
    afterAll(() => nodeFs.rmSync(tmp, { recursive: true, force: true }));

    it('allows files in the workspace and in package roots (incl. a symlink into them)', () => {
      expect(checkSourcePath(path.join(ws, 'lib', 'main.dart'), [ws, pub])).toBe(path.join(ws, 'lib', 'main.dart'));
      expect(checkSourcePath(path.join(pub, 'lib', 'dio.dart'), [ws, pub])).toBe(path.join(pub, 'lib', 'dio.dart'));
      expect(checkSourcePath(path.join(tmp, 'link_in.dart'), [ws])).toBe(path.join(ws, 'lib', 'main.dart'));
    });

    it('refuses files outside every root, symlink escapes, `..` tricks, UNC and relative paths', () => {
      const refused = /This frame points outside the workspace/;
      expect(() => checkSourcePath(path.join(outside, 'id_rsa'), [ws, pub])).toThrow(/outside the workspace: id_rsa/);
      expect(() => checkSourcePath(path.join(ws, 'lib', 'link_out.dart'), [ws])).toThrow(refused);
      expect(() => checkSourcePath(path.join(ws, 'lib', 'dir_out', 'id_rsa'), [ws])).toThrow(refused);
      expect(() => checkSourcePath(path.join(ws, 'lib', '..', '..', 'secret', 'id_rsa'), [ws])).toThrow(refused);
      expect(() => checkSourcePath('\\\\evil.example\\share\\a.dart', [ws])).toThrow(refused);
      expect(() => checkSourcePath('//evil.example/share/a.dart', [ws])).toThrow(refused);
      expect(() => checkSourcePath('lib/main.dart', [ws])).toThrow(refused);
      expect(() => checkSourcePath(path.join(ws, 'lib', 'main.dart'), [])).toThrow(refused);
      expect(() => checkSourcePath(path.join(ws, 'lib', 'main.dart'), [path.join(tmp, 'missing-root')])).toThrow(refused);
      // A sibling whose name merely starts with the root's is not inside it.
      nodeFs.mkdirSync(`${ws}-evil`, { recursive: true });
      nodeFs.writeFileSync(path.join(`${ws}-evil`, 'a.dart'), '');
      expect(() => checkSourcePath(path.join(`${ws}-evil`, 'a.dart'), [ws])).toThrow(refused);
    });

    it('a missing file is "not found", not opened', () => {
      expect(() => checkSourcePath(path.join(ws, 'lib', 'gone.dart'), [ws])).toThrow(/Source file not found: gone\.dart/);
    });
  });
});
