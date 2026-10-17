/**
 * Security headers middleware — adds intentional security-related headers
 * to every HTTP response from the events API server.
 *
 * Headers are environment-aware: production-enforcing headers are only
 * applied when the service is not in a local development context.
 * Headers that could break local development, CORS, or SSE connections
 * are deliberately omitted or conditioned.
 *
 * See: https://owasp.org/www-project-secure-headers/
 */

import type { ServerResponse } from 'http';

export function addSecurityHeaders(
  res: ServerResponse,
  options: { isProduction?: boolean } = {},
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (options.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}
