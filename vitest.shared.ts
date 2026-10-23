import { defineConfig } from 'vitest/config';

/**
 * Every package's unit tests: `test/**` against `src/**`, with the 80% coverage floor from
 * https://standards.thmsn.dev/d/testing. Pass `floor: false` where integration tests cover the
 * code instead (the extension).
 */
export function packageConfig({ floor = true }: { floor?: boolean } = {}) {
  return defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      exclude: ['test/integration/**', 'node_modules/**'],
      coverage: {
        provider: 'v8',
        include: ['src/**'],
        exclude: ['src/index.ts', 'src/testing.ts'],
        ...(floor ? { thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 } } : {}),
      },
    },
  });
}
