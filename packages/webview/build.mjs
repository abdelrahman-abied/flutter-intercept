// Builds dist/webview.js (IIFE, minified) + dist/webview.css for the extension.
//   node build.mjs          production bundle
//   node build.mjs --watch  rebuild on change
//   node build.mjs --dev    bundle + fake host, served at http://localhost:5178/dev/
import * as esbuild from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const watch = args.has('--watch') || dev;

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome114'], // VSCode >= 1.90 ships Electron 29 / Chromium 122
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
  legalComments: 'none',
};

const app = {
  ...common,
  entryPoints: { webview: join(root, 'src/main.tsx') },
  outdir: join(root, 'dist'),
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
};

const fakeHost = {
  ...common,
  entryPoints: { 'fake-host': join(root, 'dev/fake-host.ts') },
  outdir: join(root, 'dist/dev'),
  sourcemap: 'inline',
};

function report() {
  for (const f of ['dist/webview.js', 'dist/webview.css']) {
    const p = join(root, f);
    const raw = statSync(p).size;
    const gz = gzipSync(readFileSync(p)).length;
    console.log(`${f.padEnd(18)} ${(raw / 1024).toFixed(1).padStart(6)} kB  (gzip ${(gz / 1024).toFixed(1)} kB)`);
  }
}

if (!watch) {
  await esbuild.build(app);
  report();
} else {
  const ctxApp = await esbuild.context(app);
  await ctxApp.watch();
  if (dev) {
    const ctxHost = await esbuild.context(fakeHost);
    await ctxHost.watch();
    const port = Number(process.env.PORT ?? 5178);
    const { host, port: actual } = await ctxApp.serve({ servedir: root, port, host: '127.0.0.1' });
    console.log(`\n  Dev harness: http://${host}:${actual}/dev/index.html\n`);
  }
}
