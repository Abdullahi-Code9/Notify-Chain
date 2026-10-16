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
import type http from 'http';
import type { ServerResponse } from 'http';

export function addSecurityHeaders(
  res: ServerResponse,
  options: { isProduction?: boolean } = {},

const isLocalhost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

export function addSecurityHeaders(
  res: ServerResponse,
  options: { productionOrigin?: string } = {},
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ✅ X-Frame-Options: prevent clickjacking.
  // SAMEORIGIN allows embedding within same-origin iframes (dashboard use).
  // DENY would break legitimate self-embedding; SAMEORIGIN is safer.
  const frameOption = options.productionOrigin ? 'SAMEORIGIN' : 'SAMEORIGIN';
  res.setHeader('X-Frame-Options', frameOption);

  // ✅ X-XSS-Protection: legacy IE protection (defense-in-depth).
  // No known negative impact on modern API clients or SSE.
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // ✅ Referrer-Policy: control referrer information sent with requests.
  // strict-origin-when-cross-origin balances privacy and functionality.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // ✅ Cache-Control: prevent sensitive data caching in localStorage/indexedDB
  // for non-GET routes; for GET routes we allow caching where appropriate.
  const method = res.statusCode >= 200 && res.statusCode < 300 ? 'public, max-age=300' : 'no-store';
  // Only set Cache-Control if not already set by a more specific handler
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', method);
  }

  // ⚠️ Strict-Transport-Security: only in production with a valid origin.
  // Skipped for localhost/development to avoid breaking HTTP local testing.
  if (options.productionOrigin && !isLocalhost(origin || '')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (options.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}
