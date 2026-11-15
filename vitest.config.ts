import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 30_000,
    // Six test files boot their own PostgreSQL (PGlite). Running all fifteen
    // files at once peaks at well over a gigabyte and makes a slow laptop flake
    // on database startup, which looks like a failing test. Four workers keeps
    // the suite honest on a modest machine and still finishes in ~10s.
    maxWorkers: 4,
  },
});
