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
    // Companion to asyncUtilTimeout: 5000 in setupTests.ts. With findBy/waitFor
    // now allowed to poll for up to 5s, a test that waits on async DOM plus the
    // autosave specs that sleep real wall-clock (some legitimately run 3.5-12s)
    // would blow the default 5000ms test budget. 15s covers both.
    testTimeout: 15_000,
    // Backstop for whatever tips first under heavy CI contention. Only a FAILED
    // test re-runs, so the green path is unaffected; a genuine logic break fails
    // every attempt. This alone would have rescued the Admin.test.tsx flake that
    // skipped #149's deploy; asyncUtilTimeout is the root-cause fix, this is the
    // safety net.
    retry: 2,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
})












