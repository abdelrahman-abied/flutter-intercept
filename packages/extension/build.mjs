// Bundles the extension (proxy + mockttp included) and, with --tests, the integration-test harness.
// Copies the webview bundle (packages/webview/dist) to dist/webview/.
import { build } from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const withTests = process.argv.includes('--tests');
const dev = process.argv.includes('--dev');
const withSmoke = withTests || process.argv.includes('--smoke');

// Optional/lazy native or wasm deps of mockttp's tree that are never needed in the extension host:
// - tls-impersonate: native, only for upstream TLS fingerprint mirroring (off); loaded in try/catch.
// - brotli-wasm / zstd-codec: http-encoding fallbacks used only when Node lacks zlib brotli/zstd.
// - bufferutil / utf-8-validate: optional ws accelerators, loaded in try/catch.
const optionalExternals = ['tls-impersonate', 'brotli-wasm', 'zstd-codec', 'bufferutil', 'utf-8-validate'];

// Modules on code paths InterceptProxy can never hit, replaced by stubs that throw if ever used.
// See stubs/*.js for the reasoning; each stub may only be imported by the listed mockttp files.
const stubs = {
  'pac-proxy-agent': { file: 'stubs/upstream-proxy-agent.js', importers: ['mockttp/dist/rules/http-agents.js'] },
  'socks-proxy-agent': { file: 'stubs/upstream-proxy-agent.js', importers: ['mockttp/dist/rules/http-agents.js'] },
  'https-proxy-agent': { file: 'stubs/upstream-proxy-agent.js', importers: ['mockttp/dist/rules/http-agents.js'] },
  // PERF-2 #4: the MCP SDK's Zod 3 compatibility paths (every schema here is Zod 4).
  'zod/v3': { file: 'stubs/zod-v3.js', importers: ['@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js'] },
  'zod-to-json-schema': { file: 'stubs/zod-v3.js', importers: ['@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js'] },
};
const stubPlugin = {
  name: 'flutter-intercept-stubs',
  setup(b) {
    const filter = new RegExp(`^(${Object.keys(stubs).map((s) => s.replace(/[-/]/g, '\\$&')).join('|')})$`);
    b.onResolve({ filter }, (args) => {
      const stub = stubs[args.path];
      const importer = args.importer.replace(/\\/g, '/');
      if (!stub.importers.some((i) => importer.endsWith(`/node_modules/${i}`))) {
        return { errors: [{ text: `stubbed module '${args.path}' imported from unexpected ${args.importer}; re-check stubs/` }] };
      }
      return { path: path.join(here, stub.file) };
    });
  },
};

// PERF-1 #7: zod v4 re-exports ~40 locale files (`z.locales`) that nothing here uses; only `en` (its default error map,
// imported by zod itself) stays. The stub keeps the `locales` namespace with `en` only.
const zodLocalesPlugin = {
  name: 'flutter-intercept-zod-locales',
  setup(b) {
    b.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, () => ({ contents: 'export { default as en } from "./en.js";\n', loader: 'js' }));
  },
};

// PERF-3: the collection importer only reads YAML (src/mocks/yaml.ts uses `load` and `JSON_SCHEMA`). js-yaml's `exports`
// block deep imports, so `js-yaml` resolves to this shim with the loader and the JSON schema only: its writer
// (dumper.js) stays out of the bundle. Tests (vitest) load the full package; the behaviour is the same.
const jsYamlLoaderOnlyPlugin = {
  name: 'flutter-intercept-js-yaml-loader-only',
  setup(b) {
    b.onResolve({ filter: /^js-yaml$/ }, () => ({ path: 'js-yaml', namespace: 'fi-js-yaml' }));
    b.onLoad({ filter: /.*/, namespace: 'fi-js-yaml' }, () => {
      const lib = path.join(path.dirname(createRequire(import.meta.url).resolve('js-yaml')), 'lib'); // the CommonJS entry
      return {
        contents: `module.exports = { load: require(${JSON.stringify(path.join(lib, 'loader.js'))}).load, JSON_SCHEMA: require(${JSON.stringify(path.join(lib, 'schema', 'json.js'))}) };\n`,
        loader: 'js',
        resolveDir: lib,
      };
    });
  },
};

/** Bundle budgets (PERF-1 #7, PERF-2 #4): fail the build when the extension grows past them or a locale / Zod 3 slips back in.
 * CONTRACTS §21.13 (0.15.0) / PERF-3: 2 550 000 → 2 675 000 on purpose for collection mocks (2 652 908 measured with
 * js-yaml's loader only, + 20 KB); 2 700 000 after the REVIEW-15 fixes and §21.15 / §21.16 (2 678 420 + 20 KB,
 * docs/PERF-3.md §6). 0.16.0 (CONTRACTS §22–§24: store, resources, snapshots, agent tools, Record → Mock, drift,
 * sign-in, body examples, dynamic values, Swagger 2.0 / Insomnia / Bruno, the proxy's rule index and handler action):
 * 3 000 000 while the release was built, then 2 990 000 (2 965 016 measured + 20 KB, docs/PERF-4.md §3.4; all of the
 * +286 543 bytes is first-party code, no new dependency). Raise it again only on purpose. */
const MAX_EXTENSION_BYTES = 2_990_000;
function assertBudget(metafile, outfile) {
  const out = Object.entries(metafile.outputs).find(([k]) => k.endsWith(outfile));
  const bytes = out ? out[1].bytes : 0;
  const locales = Object.keys(metafile.inputs).filter((f) => /zod\/v4\/locales\/(?!en\.js$|index\.js$)/.test(f));
  if (locales.length) {
    console.error(`bundle contains zod locales (the zod-locales stub stopped matching?):\n  ${locales.slice(0, 5).join('\n  ')}`);
    process.exit(1);
  }
  const zod3 = Object.keys(metafile.inputs).filter((f) => /node_modules\/(zod\/v3|zod-to-json-schema)\//.test(f));
  if (zod3.length) {
    console.error(`bundle contains Zod 3 (the zod/v3 stub stopped matching? PERF-2 #4):\n  ${zod3.slice(0, 5).join('\n  ')}`);
    process.exit(1);
  }
  if (bytes > MAX_EXTENSION_BYTES) {
    console.error(`${outfile} is ${bytes} bytes, over the ${MAX_EXTENSION_BYTES} budget (PERF-1 #7): find what grew (dist/meta.json) or raise the budget on purpose`);
    process.exit(1);
  }
  console.log(`${outfile}: ${bytes} bytes (budget ${MAX_EXTENSION_BYTES})`);
}

// Never let these back into the bundle (mockttp's admin server / remote client / PAC engine).
const forbidden = [
  /node_modules\/mockttp\/dist\/(admin|client|pluggable-admin-api)\//,
  /node_modules\/mockttp\/dist\/main\.js$/,
  /node_modules\/(graphql|express|body-parser|raw-body|@graphql-tools|@tootallnate\/quickjs-emscripten|pac-resolver|degenerator)\//,
];
function assertNothingForbidden(metafile) {
  const bad = Object.keys(metafile.inputs).filter((f) => forbidden.some((re) => re.test(f)));
  if (bad.length) {
    console.error(`bundle contains modules that must stay out (did something import 'mockttp' directly?):\n  ${bad.slice(0, 20).join('\n  ')}`);
    process.exit(1);
  }
}

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: dev ? 'inline' : 'linked',
  logLevel: 'info',
};

for (const p of ['../proxy/dist/index.js', '../proxy/dist/rules.js', '../webview/dist/webview.js', '../webview/dist/webview.css']) {
  if (!fs.existsSync(path.join(here, p))) {
    console.error(`missing ${p}: build packages/proxy and packages/webview first (npm run build at the repo root)`);
    process.exit(1);
  }
}

await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode', ...optionalExternals],
  minify: !dev,
  keepNames: true,
  metafile: true,
  plugins: [stubPlugin, zodLocalesPlugin, jsYamlLoaderOnlyPlugin],
}).then((r) => {
  fs.writeFileSync(path.join(here, 'dist', 'meta.json'), JSON.stringify(r.metafile));
  assertNothingForbidden(r.metafile);
  if (!dev) assertBudget(r.metafile, 'dist/extension.js');
});

fs.rmSync(path.join(here, 'dist', 'webview'), { recursive: true, force: true });
fs.mkdirSync(path.join(here, 'dist', 'webview'), { recursive: true });
for (const f of ['webview.js', 'webview.css']) fs.copyFileSync(path.join(here, '..', 'webview', 'dist', f), path.join(here, 'dist', 'webview', f));

if (withTests) {
  // runTest.js runs in plain Node and launches VS Code; suite/index.js runs inside VS Code.
  await build({ ...common, entryPoints: ['test/integration/runTest.ts'], outfile: 'dist-test/runTest.js', external: ['vscode'] });
  await build({ ...common, entryPoints: ['test/integration/suite/index.ts'], outfile: 'dist-test/suite/index.js', external: ['vscode', ...optionalExternals], plugins: [stubPlugin, zodLocalesPlugin, jsYamlLoaderOnlyPlugin] });
}

if (withSmoke) {
  // Same options as dist/extension.js (minified, stubs), but runnable in plain Node.
  await build({
    ...common,
    entryPoints: ['test/bundle/smoke.ts'],
    outfile: 'dist-test/bundle-smoke.js',
    external: [...optionalExternals],
    minify: !dev,
    keepNames: true,
    metafile: true,
    plugins: [stubPlugin, zodLocalesPlugin, jsYamlLoaderOnlyPlugin],
  }).then((r) => assertNothingForbidden(r.metafile));
}
