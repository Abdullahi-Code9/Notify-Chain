/**
 * CORS Configuration Validator & Origin Policy Engine (Issue #689)
 *
 * Validates allowed CORS origins during application startup, preventing
 * accidental permissive wildcard exposure in sensitive/production environments.
 */

import cors, { CorsOptions } from 'cors';

export interface ValidatedCorsConfig {
  allowedOrigins: string[] | '*';
  isWildcard: boolean;
  corsMiddleware: ReturnType<typeof cors>;
}

/**
 * Validates CORS origin configuration and builds production-grade CORS middleware.
 * Throws explicit errors when invalid origins or dangerous production wildcards are detected.
 */
export function validateAndBuildCorsConfig(
  rawOrigins: string | undefined = process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allowProductionWildcard = false
): ValidatedCorsConfig {
  const isProduction = nodeEnv === 'production';

  // If unset, provide safe default origins
  if (!rawOrigins || rawOrigins.trim() === '') {
    if (isProduction) {
      throw new Error(
        'CORS Configuration Error: CORS_ALLOWED_ORIGINS must be explicitly configured in production environments.'
      );
    }
    // Development default: allow local dashboard and listener ports
    const devOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];
    return {
      allowedOrigins: devOrigins,
      isWildcard: false,
      corsMiddleware: cors({ origin: devOrigins, credentials: true }),
    };
  }

  const trimmed = rawOrigins.trim();

  // Wildcard handling
  if (trimmed === '*') {
    if (isProduction && !allowProductionWildcard) {
      throw new Error(
        'CORS Security Violation: Wildcard origin ("*") is prohibited in production. Explicitly list allowed origins or set ALLOW_PROD_CORS_WILDCARD=true.'
      );
    }
    return {
      allowedOrigins: '*',
      isWildcard: true,
      corsMiddleware: cors({ origin: '*' }),
    };
  }

  // Parse comma-separated list or JSON array
  let originsList: string[] = [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        originsList = parsed.map((o) => String(o).trim());
      }
    } catch {
      throw new Error(`CORS Configuration Error: Invalid JSON array format in CORS_ALLOWED_ORIGINS: ${trimmed}`);
    }
  } else {
    originsList = trimmed.split(',').map((o) => o.trim()).filter(Boolean);
  }

  if (originsList.length === 0) {
    throw new Error('CORS Configuration Error: No valid origins specified in CORS_ALLOWED_ORIGINS.');
  }

  // Validate each origin URI structure
  for (const origin of originsList) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Protocol must be http: or https: (received ${url.protocol})`);
      }
      if (url.pathname !== '' && url.pathname !== '/') {
        throw new Error(`Origin cannot contain path segments (received ${url.pathname})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CORS Configuration Error: Invalid origin URL "${origin}". Reason: ${msg}`);
    }
  }

  const options: CorsOptions = {
    origin: originsList,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-API-Key'],
    credentials: true,
    maxAge: 86400, // 24 hours
  };

  return {
    allowedOrigins: originsList,
    isWildcard: false,
    corsMiddleware: cors(options),
  };
}
