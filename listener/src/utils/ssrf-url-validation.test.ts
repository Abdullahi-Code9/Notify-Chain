import {
  UnsafeNotificationUrlError,
  validateNotificationDestinationUrl,
} from './ssrf-url-validation';

describe('validateNotificationDestinationUrl (#1205)', () => {
  it.each([
    'https://discord.com/api/webhooks/123/token',
    'https://example.com/hook',
    'http://webhook.example.test:8080/path?key=value',
    'https://8.8.8.8/hook',
  ])('accepts a valid external destination %s', (url) => {
    expect(validateNotificationDestinationUrl(url)).toBe(url);
  });

  it.each([
    'file:///etc/passwd',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'custom-app://internal',
  ])('rejects unsupported scheme %s', (url) => {
    expect(() => validateNotificationDestinationUrl(url)).toThrow(
      UnsafeNotificationUrlError,
    );
    expect(() => validateNotificationDestinationUrl(url)).toThrow(/Unsupported/);
  });

  it.each([
    'http://127.0.0.1:8080/hook',
    'http://10.0.0.5/hook',
    'http://172.16.0.1/hook',
    'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/hook',
    'http://[fc00::1]/hook',
  ])('rejects internal IP literal %s', (url) => {
    expect(() => validateNotificationDestinationUrl(url)).toThrow(
      UnsafeNotificationUrlError,
    );
  });

  it.each([
    'http://localhost/hook',
    'http://service.local/hook',
    'http://metadata.google.internal/hook',
  ])('rejects local-only hostname %s', (url) => {
    expect(() => validateNotificationDestinationUrl(url)).toThrow(/Internal/);
  });

  it('rejects embedded credentials', () => {
    expect(() =>
      validateNotificationDestinationUrl('https://user:password@example.com/hook'),
    ).toThrow(/credentials/);
  });

  it('rejects malformed URLs', () => {
    expect(() => validateNotificationDestinationUrl('not a url')).toThrow(/Malformed/);
  });
});
