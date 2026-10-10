// Bundles src/main.ts (and the vscode-free extension modules it imports) into one dist/cli.js.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  logLevel: 'warning',
});
