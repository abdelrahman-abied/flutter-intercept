// Bundles src/main.ts (and the vscode-free extension modules it imports) into one dist/sidecar.js and copies the
// webview bundle (packages/webview/dist/{webview.js,webview.css}) to dist/webview/.
// Same mockttp handling as packages/extension/build.mjs and packages/cli/build.mjs: optional native/wasm deps stay
// external, unreachable upstream-proxy agents are stubbed, mockttp's admin server / remote client must never be
// bundled, and nothing may import `vscode`.
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;

for (const p of ['../proxy/dist/index.js', '../webview/dist/webview.js', '../webview/dist/webview.css']) {
  if (!fs.existsSync(path.join(here, p))) {
    console.error(`missing ${p}: build packages/proxy and packages/webview first (npm run build at the repo root)`);
    process.exit(1);
  }
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
    // The sidecar runs outside VS Code: nothing may import it.
    b.onResolve({ filter: /^vscode$/ }, (args) => ({ errors: [{ text: `vscode imported from ${args.importer}: the sidecar may only use vscode-free modules` }] }));
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
  outfile: path.join(here, 'dist/sidecar.js'),
  define: { __FI_SIDECAR_VERSION__: JSON.stringify(version) },
  external: optionalExternals,
  plugins: [stubPlugin],
  minify: true,
  keepNames: true,
  sourcemap: 'external',
  metafile: true,
  logLevel: 'warning',
});

const bad = Object.keys(result.metafile.inputs).filter((f) => forbidden.some((re) => re.test(f)));
if (bad.length) {
  console.error(`bundle contains modules that must stay out:\n  ${bad.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
const code = fs.readFileSync(path.join(here, 'dist/sidecar.js'), 'utf8');
if (/require\(\s*["']vscode["']\s*\)/.test(code)) {
  console.error('dist/sidecar.js requires "vscode"');
  process.exit(1);
}

fs.rmSync(path.join(here, 'dist', 'webview'), { recursive: true, force: true });
fs.mkdirSync(path.join(here, 'dist', 'webview'), { recursive: true });
for (const f of ['webview.js', 'webview.css']) fs.copyFileSync(path.join(here, '..', 'webview', 'dist', f), path.join(here, 'dist', 'webview', f));
