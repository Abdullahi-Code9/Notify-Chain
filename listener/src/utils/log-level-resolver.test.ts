import {
  resolveConfiguredLogLevel,
  SUPPORTED_LOG_LEVELS,
} from './log-level-resolver';

describe('Configurable Log Level Resolver (Issue #684)', () => {
  test('resolves valid log levels regardless of whitespace or casing', () => {
    expect(resolveConfiguredLogLevel('DEBUG').level).toBe('debug');
    expect(resolveConfiguredLogLevel('  info  ').level).toBe('info');
    expect(resolveConfiguredLogLevel('WARN').level).toBe('warn');
    expect(resolveConfiguredLogLevel('error').level).toBe('error');
    expect(resolveConfiguredLogLevel('silent').level).toBe('silent');
  });

  test('defaults to "info" in production environment when unset', () => {
    const res = resolveConfiguredLogLevel(undefined, 'production');
    expect(res.level).toBe('info');
    expect(res.source).toBe('default_fallback');
  });

  test('defaults to "debug" in development environment when unset', () => {
    const res = resolveConfiguredLogLevel(undefined, 'development');
    expect(res.level).toBe('debug');
    expect(res.source).toBe('default_fallback');
  });

  test('handles invalid log level by falling back to safe default with warning', () => {
    const res = resolveConfiguredLogLevel('super_verbose', 'production');
    expect(res.level).toBe('info');
    expect(res.source).toBe('invalid_fallback');
    expect(res.warning).toContain('Invalid LOG_LEVEL');
  });
});
