// Bundles src/main.ts (and the vscode-free extension modules it imports) into dist/sidecar.js; copies the webview.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/sidecar.js',
  logLevel: 'warning',
});
