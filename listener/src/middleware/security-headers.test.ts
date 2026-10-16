import type { ServerResponse } from 'http';
import { addSecurityHeaders } from './security-headers';

function createResponse(): ServerResponse {
  return { setHeader: jest.fn() } as unknown as ServerResponse;
}

describe('addSecurityHeaders', () => {
  it('sets baseline headers without enabling HSTS or cache policy by default', () => {
    const response = createResponse();

    addSecurityHeaders(response);

    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(response.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'strict-origin-when-cross-origin',
    );
    expect(response.setHeader).not.toHaveBeenCalledWith(
      'Strict-Transport-Security',
      expect.anything(),
    );
    expect(response.setHeader).not.toHaveBeenCalledWith('Cache-Control', expect.anything());
    expect(response.setHeader).not.toHaveBeenCalledWith('X-XSS-Protection', expect.anything());
  });

  it('enables HSTS only when production is explicitly enabled', () => {
    const response = createResponse();

    addSecurityHeaders(response, { isProduction: true });

    expect(response.setHeader).toHaveBeenCalledWith(
      'Strict-Transport-Security',
      'max-age=31536000',
    );
  });
});
