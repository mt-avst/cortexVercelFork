import { defineConfig, devices } from '@playwright/test';

/**
 * Production accessibility testing config
 * Runs tests against production URL without starting local servers
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Run sequentially for production
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL || 'https://adapta-labs-p62q.vercel.app',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer - testing against production
});

