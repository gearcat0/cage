import { defineConfig } from 'vitest/config'

// Fast, pure-logic unit tests. The Electron escape suite is Playwright (*.spec.ts).
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/format/**/*.test.ts'],
    environment: 'node',
    // `pnpm test:coverage`; CI uploads the lcov report to Codecov. This is the
    // UNIT suite's coverage only: the escape suite exercises the shell and the
    // cage inside Electron and is not counted, so the number understates how
    // much of src/shell is tested.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'lcov']
    }
  }
})
