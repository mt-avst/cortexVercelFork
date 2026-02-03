import { defineConfig, devices } from '@playwright/test';

/**
 * Config for superadmin flow test - assumes dev servers already running (npm run dev:all)
 * Run: npm run dev:all &  # in one terminal
 *      npx playwright test e2e/superadmin-create-study.test.ts --config=playwright.superadmin.config.ts
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 720 },
    },
  }],
  /* No webServer - servers must be running separately */
});
