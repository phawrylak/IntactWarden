import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'extension/test/**/*.test.ts',
            'tools/**/*.test.ts',
          ],
          exclude: ['**/*.corpus.test.ts', '**/*.e2e.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        // Opt-in tests that download real upstream release assets by digest.
        // Run with `npm run test:corpus` (needs network access to github.com).
        test: {
          name: 'corpus',
          include: ['packages/*/test/**/*.corpus.test.ts', 'extension/test/**/*.corpus.test.ts'],
          environment: 'node',
          testTimeout: 600_000,
          // beforeAll hooks build whole cores from the 50 MB release zip.
          hookTimeout: 600_000,
        },
      },
      {
        // Firefox end-to-end tests against the built test package
        // (extension/test/e2e/README.md). Run with `npm run test:e2e`.
        test: {
          name: 'e2e',
          include: ['extension/test/e2e/**/*.e2e.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
