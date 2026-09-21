import { defineConfig, devices } from '@playwright/test';

/**
 * Run the backend-free browser suites against an already-running frontend (no
 * webServer): the axe accessibility pass, plus any spec that mocks every route
 * it needs and so has no database or seed data behind it.
 *
 * `testMatch` is an allow-list, so a spec that is not named here runs in NO
 * pipeline at all. `admin-pill-primitive.test.ts` (#142) sat outside it and
 * was executed by nothing but a developer's own machine - the `test-a11y` job
 * in `.gitlab-ci.yml`, which serves a real `vite build` through `vite preview`
 * on localhost:3100, is the only gate either of these suites has.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['accessibility.test.ts', 'admin-pill-primitive.test.ts'],
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
