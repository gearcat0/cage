import { defineConfig } from 'vitest/config'

// Fast, pure-logic unit tests. The Electron escape suite is Playwright (*.spec.ts).
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/format/**/*.test.ts'],
    environment: 'node'
  }
})
