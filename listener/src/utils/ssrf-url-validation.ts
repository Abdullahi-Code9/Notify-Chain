import {
  isIpAddress,
  validateResolvedAddress,
} from '../services/dns-rebinding-guard';

/**
 * Schemes accepted for user-configured notification destinations.
 *
 * Only HTTP(S) destinations are supported by the outbound delivery service;
 * `file:`, `data:`, `javascript:`, custom app schemes and other non-HTTP
 * schemes are rejected before a schedule is accepted.
 */
export const ALLOWED_NOTIFICATION_URL_SCHEMES = ['http:', 'https:'] as const;

/** Hostnames that can never represent an external notification destination. */
const BLOCKED_HOSTNAMES = ['localhost', '.localhost', '.local', '.internal'];

export class UnsafeNotificationUrlError extends Error {
  readonly name = 'UnsafeNotificationUrlError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, UnsafeNotificationUrlError.prototype);
  }
}

/**
 * Validates a user-configured notification destination at ingestion time.
 *
 * This is the first SSRF layer: it rejects unsupported schemes, credentials
 * embedded in the URL, local-only hostnames, and IP literals in blocked
 * ranges. Hostnames still have to pass the DNS rebinding guard at delivery
 * time because DNS records can change after the URL is stored.
 */
export function validateNotificationDestinationUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new UnsafeNotificationUrlError('Notification destination URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeNotificationUrlError(`Malformed notification destination URL: ${rawUrl}`);
  }

  if (!ALLOWED_NOTIFICATION_URL_SCHEMES.includes(parsed.protocol as any)) {
    throw new UnsafeNotificationUrlError(
      `Unsupported notification destination scheme: ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeNotificationUrlError(
      'Notification destination URLs must not embed credentials',
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new UnsafeNotificationUrlError('Notification destination URL has no hostname');
  }
  if (BLOCKED_HOSTNAMES.some((blocked) => hostname === blocked || hostname.endsWith(blocked))) {
    throw new UnsafeNotificationUrlError(
      `Internal notification destination is not allowed: ${hostname}`,
    );
  }

  if (isIpAddress(hostname)) {
    const addressCheck = validateResolvedAddress(hostname);
    if (!addressCheck.safe) {
      throw new UnsafeNotificationUrlError(addressCheck.reason ?? 'Blocked destination address');
    }
  }

  return rawUrl;
}
