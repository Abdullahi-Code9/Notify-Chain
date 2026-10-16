import { validateAndBuildCorsConfig } from './cors-validator';

describe('CORS Configuration Validation (Issue #689)', () => {
  test('parses comma-separated allowed origins in development', () => {
    const raw = 'https://dashboard.notifychain.io, http://localhost:3000';
    const config = validateAndBuildCorsConfig(raw, 'development');

    expect(config.isWildcard).toBe(false);
    expect(config.allowedOrigins).toEqual([
      'https://dashboard.notifychain.io',
      'http://localhost:3000',
    ]);
  });

  test('parses JSON array format for allowed origins', () => {
    const raw = JSON.stringify(['https://app.notifychain.io', 'https://admin.notifychain.io']);
    const config = validateAndBuildCorsConfig(raw, 'production');

    expect(config.allowedOrigins).toEqual([
      'https://app.notifychain.io',
      'https://admin.notifychain.io',
    ]);
  });

  test('rejects wildcard origin in production unless explicitly permitted', () => {
    expect(() => validateAndBuildCorsConfig('*', 'production', false)).toThrow(
      /Wildcard origin.*is prohibited in production/
    );
  });

  test('allows wildcard in development environment', () => {
    const config = validateAndBuildCorsConfig('*', 'development');
    expect(config.isWildcard).toBe(true);
    expect(config.allowedOrigins).toBe('*');
  });

  test('rejects invalid origin URLs and protocol schemes', () => {
    expect(() => validateAndBuildCorsConfig('ftp://invalid-origin.com', 'development')).toThrow(
      /Protocol must be http: or https:/
    );
    expect(() => validateAndBuildCorsConfig('https://domain.com/path', 'development')).toThrow(
      /Origin cannot contain path segments/
    );
  });
});
