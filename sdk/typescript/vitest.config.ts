import { defineConfig } from 'vitest/config';

// 照搬 CMA sdk/typescript/vitest.config.ts。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/commands/shot.ts'],
    },
  },
});
