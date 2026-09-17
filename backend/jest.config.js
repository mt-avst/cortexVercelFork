module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `probe` is here so the probe's GUARDS are tested on the gate that blocks a
  // merge. They decide which database gets written to and which host receives
  // an admin session cookie, and a guard whose only proof is somebody having
  // tried a bad URL by hand once protects nothing tomorrow.
  roots: ['<rootDir>/src', '<rootDir>/probe'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Vitest owns src/firsthand/** (see vitest.config.ts). Keep jest out of it so
  // the FirstHand-derived specs are never double-run by both runners.
  //
  // Vitest ALSO owns `*-postgres.test.ts` under __tests__ (#32): real-Postgres
  // concurrency tests for core routes, which cannot run here because the pool
  // is mocked. And `*-vitest.test.ts` (#60): suites that assert something about
  // the vitest side itself, which by definition cannot be proved from here.
  // Ignoring both suffixes keeps the two runners' globs DISJOINT - the include
  // in vitest.config.ts matches exactly what these patterns exclude.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/\\.',
    '/src/firsthand/',
    '-postgres\\.test\\.ts$',
    '-vitest\\.test\\.ts$',
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/db/migrate.ts',
    '!src/db/seed.ts',
    '!src/demo-server.ts',
    '!src/firsthand/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 15000,
  // D13 (AI study drafting) added a real @anthropic-ai/sdk import and its
  // zod-to-JSON-schema machinery to the backend's module graph. On the CI
  // runner's sharded `test-backend 2/2` this tipped a worker's CUMULATIVE
  // memory across a long-running suite over the container's ceiling - every
  // test passes, then the container is OOMKilled (exit 137) during cleanup.
  // Not reproducible locally (ample RAM); confirmed on the runner by
  // comparing pre-D13 main (green, 72s) against this branch's merge-ref
  // (OOMs ~63s in). This recycles a worker once its own memory passes the
  // limit, which is the standard remedy for this exact signature.
  workerIdleMemoryLimit: '512MB',
};
