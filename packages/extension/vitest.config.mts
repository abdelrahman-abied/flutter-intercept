import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.vscode-test/**', 'dist/**', 'dist-test/**'],
  },
});
