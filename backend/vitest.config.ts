import { defineConfig } from "vitest/config";

// Vitest owns the FirstHand-derived modules under src/firsthand/**, so the 48
// FirstHand specs can be ported and run unchanged (they import from "vitest").
// Jest (see jest.config.js) owns everything under src/**/__tests__/** and is
// configured to ignore src/firsthand, so the two runners never pick up the same
// file. Keep these include/ignore globs disjoint whenever tests are added.
export default defineConfig({
  test: {
    include: ["src/firsthand/**/*.{test,spec}.ts"],
    environment: "node"
  }
});
