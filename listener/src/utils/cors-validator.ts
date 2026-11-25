/**
 * CORS Configuration Validator (#689)
 *
 * Validates allowed origins during application startup:
 * - Allowed origins are explicitly configurable.
 * - Invalid origin configurations are rejected with descriptive errors.
 * - Wildcard configuration ('*') is clearly documented and restricted in sensitive environments.
 * - Sensitive environments (production, staging) do not silently fall back to permissive or wildcard settings.
 */

export class CorsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorsValidationError';
  }
}

export interface CorsValidationOptions {
  /** The configured CORS origin value (e.g. from EVENTS_API_CORS_ORIGIN). */
  corsOrigin: string;
  /** Current runtime environment (e.g. process.env.NODE_ENV). */
  nodeEnv?: string;
  /** Whether to allow wildcard origins in production if explicitly intended. Default: false. */
  allowWildcardInProduction?: boolean;
}

/** Environments treated as sensitive: permissive defaults are never allowed. */
const SENSITIVE_ENVIRONMENTS = ['production', 'prod', 'staging', 'stage'];

/** Hostnames that only make sense for local development. */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

/**
 * Returns true when the given environment is production or staging.
 */
export function isSensitiveEnvironment(nodeEnv: string = 'development'): boolean {
  return SENSITIVE_ENVIRONMENTS.includes(nodeEnv.toLowerCase());
}

/**
 * Returns true when the given origin points at a local development host.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return LOCAL_HOSTNAMES.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Validates a single CORS origin string or comma-separated list of origins.
 *
 * Supported formats:
 * - Specific URI: `http://localhost:5173`, `https://app.notifychain.io`
 * - Multiple URIs (comma-separated): `https://app.notifychain.io, https://admin.notifychain.io`
 * - Wildcard: `*` (only allowed in non-sensitive environments like development/test)
 *
 * @throws {CorsValidationError} if the origin format is invalid or insecure for the environment.
 */
export function validateCorsOrigin(options: CorsValidationOptions): string[] {
  const { corsOrigin, nodeEnv = 'development', allowWildcardInProduction = false } = options;

  if (typeof corsOrigin !== 'string' || corsOrigin.trim().length === 0) {
    throw new CorsValidationError(
      'CORS origin must be a non-empty string specifying allowed origins (e.g. "https://app.example.com" or "http://localhost:5173").'
    );
  }

  const trimmed = corsOrigin.trim();
  const isProductionOrStaging = isSensitiveEnvironment(nodeEnv);

  // Handle wildcard origin
  if (trimmed === '*') {
    if (isProductionOrStaging && !allowWildcardInProduction) {
      throw new CorsValidationError(
        'Wildcard CORS origin "*" is not permitted in production/staging environments. ' +
        'Explicitly configure allowed origins (e.g. "https://app.notifychain.io") to prevent cross-origin security vulnerabilities.'
      );
    }
    return ['*'];
  }

  // Parse comma-separated origins if provided
  const origins = trimmed.split(',').map((o) => o.trim()).filter(Boolean);

  if (origins.length === 0) {
    throw new CorsValidationError('No valid origins found in CORS configuration.');
  }

  for (const origin of origins) {
    if (origin === '*') {
      throw new CorsValidationError(
        'Cannot combine wildcard "*" with specific origins in CORS configuration.'
      );
    }

    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new CorsValidationError(
          `Invalid CORS origin protocol "${url.protocol}" in "${origin}". Only "http:" and "https:" are allowed.`
        );
      }
      // Ensure there is no trailing slash or path in the origin
      if (url.pathname !== '/' && url.pathname !== '') {
        throw new CorsValidationError(
          `CORS origin "${origin}" must not include path segments (${url.pathname}). Specify only the scheme, host, and optional port (e.g. "${url.origin}").`
        );
      }
      // Local development hosts must not be allowed in sensitive environments
      if (isProductionOrStaging && isLocalOrigin(origin)) {
        throw new CorsValidationError(
          `Local development origin "${origin}" is not permitted in ${nodeEnv} environments. ` +
          'Configure the public origin(s) that browsers will use (e.g. "https://app.notifychain.io").'
        );
      }
    } catch (err) {
      if (err instanceof CorsValidationError) throw err;
      throw new CorsValidationError(
        `Invalid CORS origin format: "${origin}". Must be a valid URL (e.g. "https://app.notifychain.io" or "http://localhost:5173").`
      );
    }
  }

  return origins;
}

export interface CorsRequestCheckOptions {
  /** The validated allow-list returned by {@link validateCorsOrigin}. */
  allowedOrigins: string[];
  /** The request's `Origin` header, if present. */
  requestOrigin?: string | null;
  /** Current runtime environment (e.g. process.env.NODE_ENV). */
  nodeEnv?: string;
}

export interface CorsRequestCheckResult {
  /** Whether the request origin is permitted. */
  allowed: boolean;
  /** The value to echo back in `Access-Control-Allow-Origin`, if any. */
  allowedOrigin?: string;
}

/**
 * Checks a request `Origin` against the configured allow-list.
 *
 * Used for both preflight (OPTIONS) and actual requests so that rejected
 * origins are handled consistently. Requests without an `Origin` header
 * (e.g. server-to-server calls) are not browser cross-origin requests and
 * are therefore allowed without an `Access-Control-Allow-Origin` header.
 *
 * @throws {CorsValidationError} if the allow-list is empty or wildcard is used in a sensitive environment.
 */
export function checkRequestOrigin(options: CorsRequestCheckOptions): CorsRequestCheckResult {
  const { allowedOrigins, requestOrigin, nodeEnv = 'development' } = options;

  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new CorsValidationError('CORS allow-list is empty; no browser origins can be served.');
  }

  const isProductionOrStaging = isSensitiveEnvironment(nodeEnv);

  if (allowedOrigins.includes('*')) {
    if (isProductionOrStaging) {
      throw new CorsValidationError(
        'Wildcard CORS origin "*" is not permitted in production/staging environments.'
      );
    }
    return { allowed: true, allowedOrigin: '*' };
  }

  if (!requestOrigin) {
    return { allowed: true };
  }

  const normalized = requestOrigin.trim();
  const match = allowedOrigins.find((origin) => origin.toLowerCase() === normalized.toLowerCase());

  if (!match) {
    return { allowed: false };
  }

  return { allowed: true, allowedOrigin: match };
}
