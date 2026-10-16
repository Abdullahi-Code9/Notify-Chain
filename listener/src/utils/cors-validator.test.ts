import { validateCorsOrigin, CorsValidationError } from './cors-validator';

describe('CORS Configuration Validation (#689)', () => {
  it('accepts a valid single origin in development', () => {
    const origins = validateCorsOrigin({
      corsOrigin: 'http://localhost:5173',
      nodeEnv: 'development',
    });
    expect(origins).toEqual(['http://localhost:5173']);
  });

  it('accepts a valid HTTPS origin in production', () => {
    const origins = validateCorsOrigin({
      corsOrigin: 'https://app.notifychain.io',
      nodeEnv: 'production',
    });
    expect(origins).toEqual(['https://app.notifychain.io']);
  });

  it('accepts multiple comma-separated origins', () => {
    const origins = validateCorsOrigin({
      corsOrigin: 'https://app.notifychain.io, https://admin.notifychain.io',
      nodeEnv: 'production',
    });
    expect(origins).toEqual(['https://app.notifychain.io', 'https://admin.notifychain.io']);
  });

  it('accepts wildcard origin in development', () => {
    const origins = validateCorsOrigin({
      corsOrigin: '*',
      nodeEnv: 'development',
    });
    expect(origins).toEqual(['*']);
  });

  it('rejects wildcard origin in production without explicit override', () => {
    expect(() =>
      validateCorsOrigin({
        corsOrigin: '*',
        nodeEnv: 'production',
      })
    ).toThrow(CorsValidationError);

    expect(() =>
      validateCorsOrigin({
        corsOrigin: '*',
        nodeEnv: 'staging',
      })
    ).toThrow(/Wildcard CORS origin "\*" is not permitted in production\/staging/);
  });

  it('rejects empty or whitespace origin string', () => {
    expect(() =>
      validateCorsOrigin({
        corsOrigin: '',
        nodeEnv: 'development',
      })
    ).toThrow(CorsValidationError);

    expect(() =>
      validateCorsOrigin({
        corsOrigin: '   ',
        nodeEnv: 'development',
      })
    ).toThrow(/non-empty string/);
  });

  it('rejects malformed origin URLs', () => {
    expect(() =>
      validateCorsOrigin({
        corsOrigin: 'not-a-url',
        nodeEnv: 'development',
      })
    ).toThrow(CorsValidationError);
  });

  it('rejects unsupported protocols such as ftp or file', () => {
    expect(() =>
      validateCorsOrigin({
        corsOrigin: 'ftp://files.notifychain.io',
        nodeEnv: 'development',
      })
    ).toThrow(/Only "http:" and "https:" are allowed/);
  });

  it('rejects origins with path segments', () => {
    expect(() =>
      validateCorsOrigin({
        corsOrigin: 'https://app.notifychain.io/api/v1',
        nodeEnv: 'development',
      })
    ).toThrow(/must not include path segments/);
  });

  it('rejects combining wildcard with specific origins', () => {
    expect(() =>
      validateCorsOrigin({
        corsOrigin: '*, https://app.notifychain.io',
        nodeEnv: 'development',
      })
    ).toThrow(/Cannot combine wildcard/);
  });
});
