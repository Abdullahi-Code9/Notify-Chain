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
  const isProductionOrStaging = ['production', 'staging', 'prod'].includes(nodeEnv.toLowerCase());

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
    } catch (err) {
      if (err instanceof CorsValidationError) throw err;
      throw new CorsValidationError(
        `Invalid CORS origin format: "${origin}". Must be a valid URL (e.g. "https://app.notifychain.io" or "http://localhost:5173").`
      );
    }
  }

  return origins;
}
