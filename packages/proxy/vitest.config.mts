import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // The LAN hardening suite measures socket deadlines; real Dart clients in the faults/dart tests running
    // alongside it starve those timers (flaky timeouts). One file at a time.
    fileParallelism: false,
  },
});
