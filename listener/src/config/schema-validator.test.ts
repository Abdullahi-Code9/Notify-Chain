import {
  validateConfigSchema,
  ConfigSchemaValidationError,
} from './schema-validator';

describe('Configuration Schema Validation (Issue #694)', () => {
  const validEnv = {
    CONTRACT_ADDRESSES: JSON.stringify([
      'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA64P7TV5A4W',
    ]),
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    POLL_INTERVAL_MS: '2000',
    LOG_LEVEL: 'info',
    PORT: '8080',
  };

  test('passes validation with valid configuration', () => {
    const config = validateConfigSchema(validEnv);

    expect(config.contractAddresses).toHaveLength(1);
    expect(config.stellarNetwork).toBe('testnet');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('info');
  });

  test('fails with descriptive error when required field is missing', () => {
    expect(() => validateConfigSchema({})).toThrow(ConfigSchemaValidationError);

    try {
      validateConfigSchema({});
    } catch (err: unknown) {
      const e = err as ConfigSchemaValidationError;
      expect(e.errors.some((err) => err.field === 'CONTRACT_ADDRESSES')).toBe(true);
    }
  });

  test('fails with field identification when enum value is invalid', () => {
    const invalidNetworkEnv = {
      ...validEnv,
      STELLAR_NETWORK: 'unknown-chain',
    };

    try {
      validateConfigSchema(invalidNetworkEnv);
      fail('Should have thrown validation error');
    } catch (err: unknown) {
      const e = err as ConfigSchemaValidationError;
      const netError = e.errors.find((err) => err.field === 'STELLAR_NETWORK');
      expect(netError).toBeDefined();
      expect(netError?.message).toContain('Allowed values');
    }
  });

  test('fails when numeric values are out of bounds', () => {
    const invalidNumericEnv = {
      ...validEnv,
      POLL_INTERVAL_MS: '10', // Below minimum 100ms
      PORT: '70000', // Above 65535
    };

    try {
      validateConfigSchema(invalidNumericEnv);
      fail('Should have thrown validation error');
    } catch (err: unknown) {
      const e = err as ConfigSchemaValidationError;
      expect(e.errors.some((err) => err.field === 'POLL_INTERVAL_MS')).toBe(true);
      expect(e.errors.some((err) => err.field === 'PORT')).toBe(true);
    }
  });
});
