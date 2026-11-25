const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/src/__tests__/accessibility.test.tsx',
    '<rootDir>/src/__tests__/accessibility-flows.test.tsx',
  ],
};
