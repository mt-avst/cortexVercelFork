import { defineConfig, devices } from '@playwright/test';

/**
 * Production Testing Configuration
 * Tests against the live production deployment
 */
export default defineConfig({
  testDir: './e2e',
  /* Quarantined: e2e/critical-flows.test.ts is not a Playwright Test spec - it drives the
   * raw `playwright` package with jest/vitest globals, and its import of '../../../shared/test-utils'
   * resolves outside the repo. Playwright throws while transforming it, which aborts collection for
   * EVERY spec in testDir, so the whole suite reported "0 tests in 0 files". Re-include it only once
   * it has been rewritten against @playwright/test and the current UI. */
  testIgnore: ['**/critical-flows.test.ts'],
  fullyParallel: false, // Run sequentially for production
  forbidOnly: !!process.env.CI,
  retries: 0, // Don't retry on production
  workers: 1, // Single worker for production
  reporter: [['html'], ['list']],
  timeout: 30000, // 30 second timeout
  
  use: {
    // Kubera playground frontend sits behind an Okta ALB - browser flows need an
    // authenticated storage state; unauthenticated smoke checks should target the
    // public backend URL (adaptalabs-backend...) instead.
    baseURL: process.env.PRODUCTION_URL || 'https://adaptalabs.kubera-playground.adaptavist.net',
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  // Don't start local server - we're testing production
  webServer: undefined,
});
