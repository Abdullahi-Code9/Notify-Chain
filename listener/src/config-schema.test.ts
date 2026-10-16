import {
  ConfigurationSchemaValidator,
  ConfigSchema,
  APP_CONFIG_SCHEMA,
} from './config-schema';

describe('Configuration Schema Validation (#694)', () => {
  const sampleValidConfig = {
    stellarNetwork: 'testnet',
    stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
    stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
    pollIntervalMs: 30000,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 5000,
    eventsApiPort: 8787,
    eventsApiCorsOrigin: 'http://localhost:5173',
    contractAddresses: [{ address: 'CABC', events: ['*'] }],
    scheduler: {
      enabled: true,
      pollIntervalMs: 10000,
      lockTimeoutMs: 60000,
      batchSize: 10,
      timingBufferMs: 60000,
    },
    rateLimit: {
      enabled: true,
      windowMs: 60000,
      maxRequests: 60,
    },
    analytics: {
      enabled: true,
      maxRecords: 10000,
      maxBuckets: 168,
      bucketSizeMs: 3600000,
      persistIntervalMs: 300000,
      snapshotRetentionDays: 30,
    },
    cleanup: {
      intervalMs: 3600000,
      notificationRetentionMs: 604800000,
      rateLimitEventRetentionMs: 86400000,
      eventRetentionMs: 86400000,
      executionLogRetentionMs: 7776000000,
    },
  };

  it('passes valid configuration against full application schema', () => {
    const errors = ConfigurationSchemaValidator.validate(sampleValidConfig, APP_CONFIG_SCHEMA);
    expect(errors).toHaveLength(0);
  });

  it('validates required fields and reports field path', () => {
    const invalidConfig = { ...sampleValidConfig, stellarRpcUrl: undefined };
    const errors = ConfigurationSchemaValidator.validate(invalidConfig, APP_CONFIG_SCHEMA);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === 'stellarRpcUrl' && e.message.includes('missing'))).toBe(true);
  });

  it('validates explicit types', () => {
    const invalidConfig = { ...sampleValidConfig, pollIntervalMs: '30000' as any };
    const errors = ConfigurationSchemaValidator.validate(invalidConfig, APP_CONFIG_SCHEMA);
    expect(errors.some((e) => e.field === 'pollIntervalMs' && e.message.includes('must be of type number'))).toBe(true);
  });

  it('validates numeric minimum and maximum bounds', () => {
    const invalidConfig = {
      ...sampleValidConfig,
      eventsApiPort: 70000,
      pollIntervalMs: 50,
    };
    const errors = ConfigurationSchemaValidator.validate(invalidConfig, APP_CONFIG_SCHEMA);
    expect(errors.some((e) => e.field === 'eventsApiPort' && e.message.includes('exceeds maximum 65535'))).toBe(true);
    expect(errors.some((e) => e.field === 'pollIntervalMs' && e.message.includes('less than minimum 1000'))).toBe(true);
  });

  it('validates enumerated values', () => {
    const invalidConfig = { ...sampleValidConfig, stellarNetwork: 'invalidnet' };
    const errors = ConfigurationSchemaValidator.validate(invalidConfig, APP_CONFIG_SCHEMA);
    expect(errors.some((e) => e.field === 'stellarNetwork' && e.message.includes('Allowed values'))).toBe(true);
  });

  it('validates nested schema fields', () => {
    const invalidConfig = {
      ...sampleValidConfig,
      scheduler: {
        ...sampleValidConfig.scheduler,
        pollIntervalMs: 100, // below 1000 min
      },
    };
    const errors = ConfigurationSchemaValidator.validate(invalidConfig, APP_CONFIG_SCHEMA);
    expect(errors.some((e) => e.field === 'scheduler.pollIntervalMs')).toBe(true);
  });

  it('validates custom regex patterns', () => {
    const invalidConfig = { ...sampleValidConfig, stellarRpcUrl: 'ftp://not-http.stellar.org' };
    const errors = ConfigurationSchemaValidator.validate(invalidConfig, APP_CONFIG_SCHEMA);
    expect(errors.some((e) => e.field === 'stellarRpcUrl' && e.message.includes('pattern'))).toBe(true);
  });

  it('rejects an out-of-range retryScheduler.webhookTimeoutMs', () => {
    const tooSmall = {
      ...sampleValidConfig,
      retryScheduler: { webhookTimeoutMs: 0 },
    };
    const tooLarge = {
      ...sampleValidConfig,
      retryScheduler: { webhookTimeoutMs: 300001 },
    };

    const smallErrors = ConfigurationSchemaValidator.validate(tooSmall, APP_CONFIG_SCHEMA);
    const largeErrors = ConfigurationSchemaValidator.validate(tooLarge, APP_CONFIG_SCHEMA);

    expect(smallErrors.some((e) => e.field === 'retryScheduler.webhookTimeoutMs')).toBe(true);
    expect(largeErrors.some((e) => e.field === 'retryScheduler.webhookTimeoutMs')).toBe(true);
  });

  it('accepts a valid retryScheduler.webhookTimeoutMs', () => {
    const config = {
      ...sampleValidConfig,
      retryScheduler: { webhookTimeoutMs: 10000 },
    };

    const errors = ConfigurationSchemaValidator.validate(config, APP_CONFIG_SCHEMA);
    expect(errors.some((e) => e.field === 'retryScheduler.webhookTimeoutMs')).toBe(false);
  });
});
