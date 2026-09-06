import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The built-artifact suite.
 *
 * Separate from vitest.config.ts because these tests read .output/ and are
 * meaningless without a build. `npm run test:built` builds both browsers and
 * then runs this; `npm test` deliberately does not, so the common path stays
 * fast and works on a fresh clone.
 */
export default defineConfig({
  resolve: {
    /*
     * The `@` alias, which this config lacked.
     *
     * These tests assert the EMITTED artifact, so most of them read files and
     * need no source. But the useful ones compare the artifact against the
     * source's own expectations - "every origin `deriveOriginPattern` can
     * produce is one the manifest declares" - and that comparison is only
     * possible if the source is importable here.
     */
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/built/**/*.test.ts'],
    reporters: ['default'],
  },
});
