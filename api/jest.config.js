module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/\\.'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Map relative shared-type imports that go up past the api/ root to the real shared/ dir
  moduleNameMapper: {
    '^../../shared/(.+)$': '<rootDir>/../shared/$1',
    '^../shared/(.+)$': '<rootDir>/../shared/$1',
  },
  testTimeout: 10000,
};
