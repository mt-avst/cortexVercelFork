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
export default defineConfig({
  test: {
    include: [
      "src/firsthand/**/*.{test,spec}.ts",
      "src/**/__tests__/**/*-postgres.test.ts"
    ],
    environment: "node"
  }
});
