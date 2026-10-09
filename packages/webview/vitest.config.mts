import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node', // component tests opt into happy-dom with a file comment
  },
});
