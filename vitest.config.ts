import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/parser/**', 'src/sourceMap.ts', 'src/policy/**', 'src/apim/**', 'src/csharp/allowedTypes.ts', 'src/csharp/lang/**'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
