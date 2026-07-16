import { defineConfig } from '@playwright/test'

// The suite drives a REAL Electron app via playwright's `_electron`, so there
// are no browser projects. Runs serially (one Electron app + one canary at a
// time) for a clean, deterministic green wall.
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['./test/green-wall-reporter.ts']]
})
