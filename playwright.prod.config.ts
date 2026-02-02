import { defineConfig, devices } from '@playwright/test';

/**
 * Production Testing Configuration
 * Tests against the live production deployment
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Run sequentially for production
  forbidOnly: !!process.env.CI,
  retries: 0, // Don't retry on production
  workers: 1, // Single worker for production
  reporter: [['html'], ['list']],
  timeout: 30000, // 30 second timeout
  
  use: {
    baseURL: process.env.PRODUCTION_URL || 'https://adapta-labs-p62q.vercel.app',
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
