import { defineConfig, devices } from '@playwright/test';

/** Run accessibility (axe) tests against already-running frontend (no webServer). */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'accessibility.test.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    /* Overridable, so a machine with something else on port 3000 can point this
     * at the real stack. */
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  /* No webServer - start frontend (and backend if needed) before running */
});
