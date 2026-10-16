/**
 * Structured-logging tests: format selection, level parsing, and the
 * redaction that keeps credentials out of the aggregator.
 *
 * The existing logger.test.ts covers formatError and the level fallback; this
 * file covers the parts added for configurable JSON output and secret
 * exclusion.
 */

import {
  REDACTED_PLACEHOLDER,
  SUPPORTED_LOG_FORMATS,
  SUPPORTED_LOG_LEVELS,
  isSensitiveKey,
  parseLogFormat,
  parseLogLevel,
  redactSensitive,
  resolveLogFormat,
  resolveLogLevel,
  sanitizeUrl,
} from './logger';

// ── Level parsing ───────────────────────────────────────────────────────────

describe('log level parsing', () => {
  it('documents the supported levels', () => {
    expect([...SUPPORTED_LOG_LEVELS]).toEqual(['error', 'warn', 'info', 'debug']);
  });

  it.each(['error', 'warn', 'info', 'debug'])('accepts %s', (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  it('normalises case and surrounding whitespace', () => {
    expect(parseLogLevel('  DEBUG ')).toBe('debug');
  });

  it('returns null for an unrecognised level', () => {
    // Strict, unlike resolveLogLevel: config validation needs to be able to
    // reject rather than silently downgrade.
    expect(parseLogLevel('verbose')).toBeNull();
    expect(parseLogLevel('trace')).toBeNull();
    expect(parseLogLevel('')).toBeNull();
    expect(parseLogLevel(undefined)).toBeNull();
  });

  it('resolveLogLevel still falls back rather than throwing', () => {
    // A bad value must never crash a running process, only fail validation.
    expect(resolveLogLevel('nonsense')).toBe('info');
    expect(resolveLogLevel(undefined)).toBe('info');
  });
});

// ── Format selection ────────────────────────────────────────────────────────

describe('log format selection', () => {
  it('documents the supported formats', () => {
    expect([...SUPPORTED_LOG_FORMATS]).toEqual(['json', 'pretty']);
  });

  it('accepts json and pretty', () => {
    expect(parseLogFormat('json')).toBe('json');
    expect(parseLogFormat('PRETTY')).toBe('pretty');
  });

  it('returns null for an unrecognised format', () => {
    expect(parseLogFormat('logfmt')).toBeNull();
    expect(parseLogFormat(undefined)).toBeNull();
  });

  it('lets an explicit format win over the environment', () => {
    // JSON can be enabled anywhere — reproducing an aggregator problem
    // locally should not require pretending to be production.
    expect(resolveLogFormat('json', 'development')).toBe('json');
    expect(resolveLogFormat('pretty', 'production')).toBe('pretty');
  });

  it('falls back to the previous environment-based behaviour when unset', () => {
    expect(resolveLogFormat(undefined, 'production')).toBe('json');
    expect(resolveLogFormat(undefined, 'development')).toBe('pretty');
    expect(resolveLogFormat(undefined, undefined)).toBe('pretty');
  });
});

// ── Sensitive key detection ─────────────────────────────────────────────────

describe('sensitive key detection', () => {
  it.each([
    'password',
    'apiKey',
    'API_KEY',
    'x-api-key',
    'webhookSecret',
    'Authorization',
    'accessToken',
    'privateKey',
    'signature',
    'cookie',
  ])('flags %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['requestId', 'durationMs', 'statusCode', 'method', 'url', 'count'])(
    'leaves %s alone',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

// ── Redaction ───────────────────────────────────────────────────────────────

describe('redaction', () => {
  it('replaces a credential value while keeping the field', () => {
    // The key stays so the shape of the record is stable for the aggregator;
    // only the value is withheld.
    const output = redactSensitive({ requestId: 'abc', apiKey: 'sk_live_123' }) as Record<
      string,
      unknown
    >;

    expect(output.requestId).toBe('abc');
    expect(output.apiKey).toBe(REDACTED_PLACEHOLDER);
  });

  it('redacts nested credentials', () => {
    const output = redactSensitive({
      request: { headers: { authorization: 'Bearer xyz' }, path: '/api' },
    }) as any;

    expect(output.request.headers.authorization).toBe(REDACTED_PLACEHOLDER);
    expect(output.request.path).toBe('/api');
  });

  it('redacts inside arrays', () => {
    const output = redactSensitive([{ token: 'a' }, { token: 'b' }]) as any[];

    expect(output[0].token).toBe(REDACTED_PLACEHOLDER);
    expect(output[1].token).toBe(REDACTED_PLACEHOLDER);
  });

  it('leaves primitives untouched', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });

  it('passes Errors through for formatError to handle', () => {
    const error = new Error('boom');
    expect(redactSensitive(error)).toBe(error);
  });

  it('stops recursing on deeply nested input', () => {
    // Logging must never be the thing that hangs the service, so depth is
    // bounded rather than trusting the input to be well-shaped.
    let deep: Record<string, unknown> = { secret: 'leaf' };
    for (let i = 0; i < 50; i++) deep = { nested: deep };

    expect(() => redactSensitive(deep)).not.toThrow();
  });

  it('redacts the top level of an over-deep object', () => {
    const output = redactSensitive({ password: 'p', nested: { token: 't' } }) as any;
    expect(output.password).toBe(REDACTED_PLACEHOLDER);
    expect(output.nested.token).toBe(REDACTED_PLACEHOLDER);
  });
});

// ── URL sanitization ────────────────────────────────────────────────────────

describe('URL sanitization', () => {
  it('leaves a path without a query string alone', () => {
    expect(sanitizeUrl('/api/notifications')).toBe('/api/notifications');
  });

  it('keeps the path, which is what identifies the endpoint', () => {
    expect(sanitizeUrl('/api/events?token=secret')).toContain('/api/events');
  });

  it('redacts credential-bearing query parameters', () => {
    const output = sanitizeUrl('/api/events?token=sk_live_abc&limit=10');

    expect(output).not.toContain('sk_live_abc');
    expect(output).toContain(REDACTED_PLACEHOLDER);
    // Non-sensitive parameters survive — they are useful for diagnosis.
    expect(output).toContain('limit=10');
  });

  it('redacts several sensitive parameters at once', () => {
    const output = sanitizeUrl('/api?api_key=a&signature=b&page=2');

    expect(output).not.toContain('=a');
    expect(output).not.toContain('=b');
    expect(output).toContain('page=2');
  });

  it('handles an empty query string', () => {
    expect(sanitizeUrl('/api/events?')).toBe('/api/events');
  });
});
