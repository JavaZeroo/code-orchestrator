import { defineConfig } from 'vitest/config';

export const unitTestConfig = defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/*.st.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.st.test.{ts,tsx}',
        'src/vendor/**',
        'src/index.ts',
        'src/main.tsx',
        'src/container-agent/main.ts',
      ],
      reporter: ['text', 'json', 'lcov'],
      thresholds: {
        branches: 0.1,
        functions: 1,
        lines: 1,
        statements: 1,
      },
    },
  },
});
