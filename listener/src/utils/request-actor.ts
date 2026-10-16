import crypto from 'crypto';
import http from 'http';

/**
 * Stable, non-reversible identifier for a credential.
 *
 * The same credential always maps to the same fingerprint, so audit records
 * stay attributable, but the stored value can never be replayed as the
 * credential itself. Audit records are immutable and readable through the
 * audit API, so the raw key/token must never be written there.
 */
export function fingerprintCredential(credential: string): string {
  return crypto.createHash('sha256').update(credential, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Derives an accountable actor identifier from request auth headers or client IP.
 * Used for audit trails on admin mutations (e.g. template updates).
 *
 * Credentials are recorded as fingerprints (`api-key:<fp>`, `bearer:<fp>`),
 * never in clear text.
 */
export function resolveRequestActor(req: http.IncomingMessage): string {
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return `api-key:${fingerprintCredential(apiKeyHeader.trim())}`;
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      return `bearer:${fingerprintCredential(token)}`;
    }
  }

  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
    const clientIp = xForwardedFor.split(',')[0].trim();
    if (clientIp) {
      return `ip:${clientIp}`;
    }
  }

  const remoteIp = req.socket.remoteAddress || 'unknown';
  return `ip:${remoteIp}`;
}
