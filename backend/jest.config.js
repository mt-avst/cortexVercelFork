module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Vitest owns src/firsthand/** (see vitest.config.ts). Keep jest out of it so
  // the FirstHand-derived specs are never double-run by both runners.
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/\\.', '/src/firsthand/'],
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
};
