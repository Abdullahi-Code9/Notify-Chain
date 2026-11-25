module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'jsdom',
  testTimeout: 15000,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  collectCoverageFrom: ['<rootDir>/src/**/*.{ts,tsx}'],
  coveragePathIgnorePatterns: [
    '<rootDir>/src/**\\/**/*.d.ts',
    '<rootDir>/src/**\\/**/*.test.{ts,tsx}',
    '<rootDir>/src/**\\/**/*.stories.{ts,tsx}',
    '<rootDir>/src/test/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  moduleNameMapper: {
    '^@creit\\.tech/stellar-wallets-kit/modules/utils$':
      '<rootDir>/src/test/stellarWalletsKitModulesMock.ts',
    '^@creit\\.tech/stellar-wallets-kit$':
      '<rootDir>/src/test/stellaeWalletsKitMock.ts',
    '^.*\\/config/stellarNetwork$': '<rootDir>/src/test/stellarNetworkMock.ts',
    '^.*\\/config/eventsApiUrl$': '<rootDir>/src/test/eventsApiUrlMock.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
      },
    ],
  },
};
