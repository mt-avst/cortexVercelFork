import { defineConfig } from "vitest/config";

// Vitest owns the FirstHand-derived modules under src/firsthand/**, so the 48
// FirstHand specs can be ported and run unchanged (they import from "vitest").
// Jest (see jest.config.js) owns everything under src/**/__tests__/** and is
// configured to ignore src/firsthand, so the two runners never pick up the same
// file. Keep these include/ignore globs disjoint whenever tests are added.
//
// Vitest ALSO owns `*-postgres.test.ts` under src/**/__tests__/** (#32). Those
// are real-Postgres concurrency/transaction tests for CORE routes, which Jest
// cannot exercise because jest.config.js mocks the pool. Jest's
// testPathIgnorePatterns skips exactly this suffix, so the globs stay disjoint:
// a `*-postgres.test.ts` under __tests__ is vitest-only, every other
// `*.test.ts` under __tests__ is jest-only. `test-backend-db` runs these
// against a real Postgres (`vitest run postgres`); the no-DB vitest job skips
// them via FIRSTHAND_SKIP_DB_TESTS.
//
// And `*-vitest.test.ts` under src/**/__tests__/** (#60), which is where a
// guard on THIS FILE has to live. `-postgres` was the only vitest-owned suffix
// outside src/firsthand, and every one of those needs a database - so a test
// proving the `setupFiles` below is wired would have been switched off by
// default on the gate that blocks a merge. jest.config.js excludes the same
// suffix, so the two runners' globs stay disjoint exactly as they did before:
// a `*-postgres.test.ts` or a `*-vitest.test.ts` under __tests__ is
// vitest-only, every other `*.test.ts` under __tests__ is jest-only.
//
// `setupFiles` is #60 itself. `src/__tests__/setup.ts` is jest's
// `setupFilesAfterEnv`, so the pooled keep-alive test agent it installs
// (cto/AdaptaLabs#44) never reached this side and every supertest call here
// opened a connection it threw away. See helpers/vitest-setup.ts for why it is
// a separate file rather than a shared one, and for the measured teardown
// ordering, which relative to a test file's own `afterAll` is the reverse of
// jest's.
export default defineConfig({
  test: {
    include: [
      "src/firsthand/**/*.{test,spec}.ts",
      "src/**/__tests__/**/*-postgres.test.ts",
      "src/**/__tests__/**/*-vitest.test.ts"
    ],
    setupFiles: ["src/__tests__/helpers/vitest-setup.ts"],
    environment: "node"
  }
});
