/**
 * CORS Configuration Validator & Origin Policy Engine (Issue #689)
 *
 * Validates allowed CORS origins during application startup, preventing
 * accidental permissive wildcard exposure in sensitive/production environments.
 */

import cors, { CorsOptions } from 'cors';

export type CorsEnvironment = 'development' | 'staging' | 'production';

export interface ValidatedCorsConfig {
  environment: CorsEnvironment;
  allowedOrigins: string[] | '*';
  isWildcard: boolean;
  corsMiddleware: ReturnType<typeof cors>;
}

/**
 * Environment-specific default origins used when CORS_ALLOWED_ORIGINS is unset.
 * Production intentionally has NO defaults: origins must be explicitly configured.
 */
const ENVIRONMENT_DEFAULT_ORIGINS: Record<CorsEnvironment, string[]> = {
  development: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'],
  staging: ['https://staging.example.com'],
  production: [],
};

/**
 * Normalizes an arbitrary NODE_ENV value into a supported CorsEnvironment.
 * Unknown values are treated as production (fail-closed / most restrictive).
 */
export function resolveCorsEnvironment(nodeEnv: string | undefined): CorsEnvironment {
  const normalized = (nodeEnv || '').trim().toLowerCase();
  if (normalized === 'development' || normalized === 'dev') return 'development';
  if (normalized === 'staging' || normalized === 'stage') return 'staging';
  return 'production';
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
  const environment = resolveCorsEnvironment(nodeEnv);
  const isProduction = environment === 'production';

  // If unset, provide environment-specific defaults (production has none)
  if (!rawOrigins || rawOrigins.trim() === '') {
    if (isProduction) {
      throw new Error(
        'CORS Configuration Error: CORS_ALLOWED_ORIGINS must be explicitly configured in production environments.'
      );
    }
    const defaultOrigins = ENVIRONMENT_DEFAULT_ORIGINS[environment];
    return {
      environment,
      allowedOrigins: defaultOrigins,
      isWildcard: false,
      corsMiddleware: buildCorsMiddleware(defaultOrigins),
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
      environment,
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
      if (isProduction && isLocalhostOrigin(url)) {
        throw new Error(
          `Localhost origin "${origin}" is not permitted in production. Configure an explicit public origin.`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CORS Configuration Error: Invalid origin URL "${origin}". Reason: ${msg}`);
    }
  }

  return {
    environment,
    allowedOrigins: originsList,
    isWildcard: false,
    corsMiddleware: buildCorsMiddleware(originsList),
  };
}

function isLocalhostOrigin(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Builds CORS middleware that validates the request Origin on both preflight
 * (OPTIONS) and actual requests. Requests from disallowed origins are rejected
 * by omitting the Access-Control-Allow-Origin header (browser blocks them).
 */
function buildCorsMiddleware(allowedOrigins: string[]): ReturnType<typeof cors> {
  const allowedSet = new Set(allowedOrigins);
  const options: CorsOptions = {
    origin: (origin, callback) => {
      // Allow same-origin / non-browser requests that omit the Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedSet.has(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-API-Key'],
    credentials: true,
    maxAge: 86400, // 24 hours
    optionsSuccessStatus: 204,
  };
  return cors(options);
}
