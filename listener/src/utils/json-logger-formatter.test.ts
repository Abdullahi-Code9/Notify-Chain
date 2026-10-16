import {
  createStructuredJsonFormat,
  isJsonLoggingEnabled,
} from './json-logger-formatter';

describe('Structured JSON Logging Option (Issue #685)', () => {
  describe('isJsonLoggingEnabled', () => {
    test('enables when STRUCTURED_LOGGING=true', () => {
      expect(isJsonLoggingEnabled({ STRUCTURED_LOGGING: 'true' })).toBe(true);
    });

    test('enables when LOG_FORMAT=json', () => {
      expect(isJsonLoggingEnabled({ LOG_FORMAT: 'json' })).toBe(true);
    });

    test('enables by default in production unless explicitly disabled', () => {
      expect(isJsonLoggingEnabled({ NODE_ENV: 'production' })).toBe(true);
      expect(isJsonLoggingEnabled({ NODE_ENV: 'production', STRUCTURED_LOGGING: 'false' })).toBe(false);
    });
  });

  describe('createStructuredJsonFormat', () => {
    test('formats log info into standard single-line JSON', () => {
      const formatter = createStructuredJsonFormat({
        serviceName: 'notify-chain-listener',
        environment: 'staging',
      });

      const logInfo = {
        level: 'info',
        message: 'Notification delivered successfully',
        timestamp: '2026-08-29T12:00:00.000Z',
        requestId: 'req-456',
        durationMs: 42.5,
        eventId: 'evt-001',
      };

      const result = (formatter.transform(logInfo as any) as any)[Symbol.for('message')];
      const parsed = JSON.parse(result);

      expect(parsed.level).toBe('info');
      expect(parsed.service).toBe('notify-chain-listener');
      expect(parsed.environment).toBe('staging');
      expect(parsed.requestId).toBe('req-456');
      expect(parsed.durationMs).toBe(42.5);
      expect(parsed.eventId).toBe('evt-001');
    });

    test('strictly redacts sensitive secrets in structured JSON logs', () => {
      const secret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKD45DCAHSKV2U2B6P6IRKD45';
      const formatter = createStructuredJsonFormat();

      const logInfo = {
        level: 'error',
        message: `Failed sending to endpoint using ${secret}`,
        timestamp: '2026-08-29T12:00:00.000Z',
        apiKey: 'super-secret-key-12345',
        error: {
          name: 'AuthError',
          message: `Invalid token ${secret}`,
        },
      };

      const result = (formatter.transform(logInfo as any) as any)[Symbol.for('message')];
      const parsed = JSON.parse(result);

      expect(parsed.apiKey).toBe('[REDACTED]');
      expect(parsed.message).not.toContain(secret);
      expect(parsed.error.message).not.toContain(secret);
    });
  });
});
