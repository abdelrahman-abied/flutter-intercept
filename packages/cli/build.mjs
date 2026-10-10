// Bundles src/main.ts (and the vscode-free extension modules it imports) into one dist/cli.js, and src/action.ts
// (the GitHub Action's entry, root action.yml) into dist/action.js, which loads dist/cli.js at run time.
// Same mockttp handling as packages/extension/build.mjs: optional native/wasm deps stay external, unreachable
// upstream-proxy agents are stubbed, and mockttp's admin server / remote client must never be bundled.
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;

if (!fs.existsSync(path.join(here, '../proxy/dist/index.js'))) {
  console.error('missing ../proxy/dist/index.js: build packages/proxy first (npm run build at the repo root)');
  process.exit(1);
}

const optionalExternals = ['tls-impersonate', 'brotli-wasm', 'zstd-codec', 'bufferutil', 'utf-8-validate'];

const stubFile = path.join(here, '../extension/stubs/upstream-proxy-agent.js');
const stubs = {
  'pac-proxy-agent': { importers: ['mockttp/dist/rules/http-agents.js'] },
  'socks-proxy-agent': { importers: ['mockttp/dist/rules/http-agents.js'] },
  'https-proxy-agent': { importers: ['mockttp/dist/rules/http-agents.js'] },
};
const stubPlugin = {
  name: 'flutter-intercept-stubs',
  setup(b) {
    const filter = new RegExp(`^(${Object.keys(stubs).map((s) => s.replace(/[-/]/g, '\\$&')).join('|')})$`);
    b.onResolve({ filter }, (args) => {
      const importer = args.importer.replace(/\\/g, '/');
      if (!stubs[args.path].importers.some((i) => importer.endsWith(`/node_modules/${i}`))) {
        return { errors: [{ text: `stubbed module '${args.path}' imported from unexpected ${args.importer}` }] };
      }
      return { path: stubFile };
    });
    // The CLI runs outside VS Code: nothing may import it.
    b.onResolve({ filter: /^vscode$/ }, (args) => ({ errors: [{ text: `vscode imported from ${args.importer}: the CLI may only use vscode-free modules` }] }));
  },
};

const forbidden = [
  /node_modules\/mockttp\/dist\/(admin|client|pluggable-admin-api)\//,
  /node_modules\/mockttp\/dist\/main\.js$/,
  /node_modules\/(graphql|express|body-parser|raw-body|@graphql-tools|@tootallnate\/quickjs-emscripten|pac-resolver|degenerator)\//,
];

const result = await esbuild.build({
  entryPoints: [path.join(here, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(here, 'dist/cli.js'),
  banner: { js: '#!/usr/bin/env node' },
  define: { __FI_CLI_VERSION__: JSON.stringify(version) },
  external: optionalExternals,
  plugins: [stubPlugin],
  minify: true,
  keepNames: true,
  // external: the map stays out of the npm package (files: dist/cli.js) and the bundle has no dangling map URL
  sourcemap: 'external',
  metafile: true,
  logLevel: 'warning',
});

const bad = Object.keys(result.metafile.inputs).filter((f) => forbidden.some((re) => re.test(f)));
if (bad.length) {
  console.error(`bundle contains modules that must stay out:\n  ${bad.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
fs.chmodSync(path.join(here, 'dist/cli.js'), 0o755);

// The GitHub Action entry: small, readable, loads ./cli.js at run time (not bundled twice). Not in the npm package.
await esbuild.build({
  entryPoints: [path.join(here, 'src/action.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(here, 'dist/action.js'),
  plugins: [stubPlugin],
  logLevel: 'warning',
});
