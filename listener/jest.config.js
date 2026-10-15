module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: {
          ignoreCodes: [2307],
        },
      },
    ],
  },
  moduleNameMapper: {
    '^uuid$': '<rootDir>/src/__mocks__/uuid.js',
    '^@stellar/stellar-sdk$': '<rootDir>/src/__mocks__/@stellar/stellar-sdk.ts',
    '^node-cache$': '<rootDir>/src/__mocks__/node-cache.ts',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
