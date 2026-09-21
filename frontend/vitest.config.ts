import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // macOS resource-fork files (._*) on the external drive are not tests
    exclude: ['**/node_modules/**', '**/._*'],
    // The OpportunityForm autosave specs drive the component's REAL timers
    // (2s debounce, 5s min-interval, retry backoff) by sleeping wall-clock,
    // so a handful of tests legitimately take 3.5-12s. Against the default
    // 5000ms the ~3.5s ones sit on a ~1.4s margin; a contended shared CI
    // runner eats it and they time out by name, reddening test-frontend and
    // skipping the deploy. 15s gives them real headroom.
    testTimeout: 15_000,
    // Backstop for the wall-clock tests whose own explicit timeouts are still
    // thin under heavy contention. Only a FAILED test re-runs, so the green
    // path is unaffected; a genuine logic break fails all attempts.
    retry: 2,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
})












