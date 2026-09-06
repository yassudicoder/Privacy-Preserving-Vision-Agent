import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    // Default is node. Files that need a DOM opt in with a
    //   // @vitest-environment jsdom
    // docblock at the top. Keeps the fast tests fast.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // tests/built asserts the EMITTED artifact, so it needs a build first.
    // It runs via `npm run test:built`, which builds. Keeping it out of the
    // default run is what lets `npm test` stay fast and build-free.
    exclude: ['node_modules/**', 'tests/built/**'],
    // Resource budgets are measured, so a noisy-neighbour test run skews them.
    // Keep the resource suite single-threaded and isolated.
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    reporters: ['default'],
  },
});
