/**
 * Endpoint-aware request policy (Issue #1138).
 *
 * Centralises the two request-side checks that every mutating API endpoint
 * needs: how large a body may be, and which media types it accepts.
 *
 * A single global ceiling is not enough: bulk endpoints legitimately accept
 * far more data than the interactive ones, while a JSON-only endpoint must
 * not silently accept a CSV or XML document. Keeping both decisions in one
 * place lets the server apply them before it starts buffering or routing a
 * request, so an oversized or unsupported payload is never processed.
 */

import { normaliseApiPath } from '../api/api-version-registry';
import { DEFAULT_MAX_BODY_BYTES } from './body-limit';

export const JSON_MIME_TYPE = 'application/json';

/** Media types accepted by the bulk import endpoint. */
export const IMPORT_MIME_TYPES: readonly string[] = [
  JSON_MIME_TYPE,
  'text/csv',
  'application/csv',
];

export const IMPORT_ENDPOINT = '/api/notifications/import';
export const VALIDATE_BATCH_ENDPOINT = '/api/notifications/validate-batch';

/**
 * Per-endpoint body ceilings. Endpoints not listed here use the configured
 * default (`API_MAX_BODY_BYTES`, 1 MiB out of the box).
 */
export const ENDPOINT_BODY_LIMITS: Record<string, number> = {
  [IMPORT_ENDPOINT]: 5 * 1024 * 1024,
  [VALIDATE_BATCH_ENDPOINT]: 2 * 1024 * 1024,
};

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export interface RequestPolicy {
  /** Largest body accepted for this request, in bytes. */
  maxBytes: number;
  /** MIME types accepted for this request. */
  allowedContentTypes: string[];
}

/**
 * Reduces a request path to its canonical, versionless, lowercase form.
 *
 * `/api/v1/notifications/import/` and `/api/notifications/import` resolve to
 * the same policy so versioned clients get identical enforcement.
 */
export function canonicalRequestPath(pathname: string): string {
  const withoutQuery = (pathname ?? '').split('?')[0];
  const { normalisedPath } = normaliseApiPath(withoutQuery);
  const withoutTrailingSlash =
    normalisedPath.length > 1 && normalisedPath.endsWith('/')
      ? normalisedPath.slice(0, -1)
      : normalisedPath;
  return withoutTrailingSlash.toLowerCase();
}

/**
 * Resolves the size limit and accepted media types for one request.
 *
 * Safe methods keep the configured default because they carry no body worth
 * screening; `validateContentType` independently skips them as well.
 */
export function resolveRequestPolicy(
  method: string,
  pathname: string,
  defaultMaxBytes: number = DEFAULT_MAX_BODY_BYTES,
): RequestPolicy {
  const canonical = canonicalRequestPath(pathname);
  const upperMethod = (method ?? 'GET').toUpperCase();

  const maxBytes =
    BODY_METHODS.has(upperMethod) && ENDPOINT_BODY_LIMITS[canonical] !== undefined
      ? ENDPOINT_BODY_LIMITS[canonical]
      : defaultMaxBytes;

  const allowedContentTypes =
    canonical === IMPORT_ENDPOINT ? [...IMPORT_MIME_TYPES] : [JSON_MIME_TYPE];

  return { maxBytes, allowedContentTypes };
}
