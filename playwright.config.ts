import { defineConfig, devices } from '@playwright/test';

/**
 * @see https://playwright.dev/docs/test-configuration
 */

/* Where the frontend is served. Override with BASE_URL when port 3000 is taken,
 * e.g. BASE_URL=http://localhost:3100 npm run test:e2e */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
/* Where the backend API listens. */
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const FRONTEND_PORT = new URL(BASE_URL).port || '3000';

export default defineConfig({
  testDir: './e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  /* `open: 'never'` matters: the HTML reporter defaults to open-on-failure,
   * which starts a report server and BLOCKS waiting for a human. A failing run
   * then never returns - it looks like a hung job rather than a failed one, and
   * in CI it would sit there until the job timeout. Observed on a real run that
   * finished in 32s and was still holding port 9323 fourteen minutes later. */
  reporter: [['html', { open: 'never' }], ['list']],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: BASE_URL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },

    /* Test against branded browsers. */
    {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests.
   * Set PLAYWRIGHT_NO_WEBSERVER=1 to skip (use your already-running backend + frontend). */
  webServer: process.env.PLAYWRIGHT_NO_WEBSERVER
    ? undefined
    : [
        {
          command: 'cd backend && npm run dev',
          url: API_BASE_URL,
          reuseExistingServer: !process.env.CI,
        },
        {
          command: `cd frontend && npm start -- --port ${FRONTEND_PORT} --strictPort`,
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
